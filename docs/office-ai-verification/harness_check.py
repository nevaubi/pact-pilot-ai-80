import asyncio, json, os, sys
from pathlib import Path
from playwright.async_api import async_playwright
SHOTS = Path(__file__).parent / "screenshots"; SHOTS.mkdir(parents=True, exist_ok=True)
R = {}
def rec(k, ok, detail=""):
    R[k] = {"pass": bool(ok), "detail": detail}; print(("PASS " if ok else "FAIL ") + k, detail)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1600, "height": 1000})
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto("http://localhost:8080/")
        sk = os.environ.get("LOVABLE_BROWSER_SUPABASE_STORAGE_KEY"); sj = os.environ.get("LOVABLE_BROWSER_SUPABASE_SESSION_JSON")
        if sk and sj: await page.evaluate(f"localStorage.setItem({json.dumps(sk)}, {json.dumps(sj)})")
        await page.goto("http://localhost:8080/dev/office-harness", wait_until="domcontentloaded")
        await page.wait_for_function("window.__harness && window.__harness.docx() && window.__harness.sheet() && window.__mirzaDocx?.activeEditor?.doc", timeout=90000)
        await page.wait_for_timeout(2500)
        rec("mount docx+xlsx", True)
        await page.screenshot(path=str(SHOTS/"1_mounted.png"))

        # ---- Word: tracked replace + insert + format, refusals, unknown receipt
        r = await page.evaluate("""async () => window.__harness.docx().applyProposal({kind:'word', summary:'s', edits:[
          {op:'replace', find:'ten (10) business days', replace:'five (5) business days'},
          {op:'insert_after', anchor:'[[Closing Date]].', text:' Time is of the essence.'}]})""")
        rec("word replace+insert applied", r.get("ok") and r.get("applied")==2, json.dumps(r))
        tc = await page.evaluate("async () => (await window.__mirzaDocx.activeEditor.doc.trackChanges.list({})).total")
        rec("tracked changes present", tc and tc >= 2, f"tracked={tc}")
        f = await page.evaluate("""async () => window.__harness.docx().applyProposal({kind:'word', summary:'s', edits:[
          {op:'format', find:'ARTICLE 1 DEFINITIONS', format:{bold:true, italic:true, underline:null, fontSize:14, fontFamily:null}}]})""")
        rec("word format applied (or explicit limitation)", f.get("ok") or "reason" in f, json.dumps(f))
        dup = await page.evaluate("""async () => window.__harness.docx().applyProposal({kind:'word', summary:'s', edits:[{op:'replace', find:'Buyer pays the fee.', replace:'Seller pays.'}]})""")
        rec("duplicate anchor refused", not dup.get("ok") and dup.get("applied")==0, dup.get("reason",""))
        stale = await page.evaluate("""async () => window.__harness.docx().applyProposal({kind:'word', summary:'s', edits:[{op:'replace', find:'ten (10) business days', replace:'x'}]})""")
        rec("stale anchor refused (live revalidation)", not stale.get("ok"), stale.get("reason",""))
        unk = await page.evaluate("""async () => { const real = window.__mirzaDocx.activeEditor.doc;
          const d = new Proxy(real, { get: (t, k) => k === 'mutations' ? { preview: (i) => t.mutations.preview(i), apply: async () => ({}) } : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
          const before = await real.getText({});
          const r = await window.__harness.applyVia(d, [{op:'replace', find:'[[Closing Date]]', replace:'June 30, 2026'}]);
          return { ...r, unchanged: (await real.getText({})) === before } }""")
        rec("unknown receipt ({}) fails in the real adapter", not unk.get("ok") and unk.get("unchanged"), unk.get("reason",""))
        await page.screenshot(path=str(SHOTS/"2_word_tracked.png"))
        # export + reopen keeps tracked changes
        n_before = await page.evaluate("async () => (await window.__mirzaDocx.activeEditor.doc.trackChanges.list({})).total")
        await page.evaluate("""async () => { const b = await window.__harness.docx().export(); window.__exported = b; await window.__harness.reopenDocx(b); }""")
        await page.wait_for_timeout(1500)
        await page.wait_for_function("window.__mirzaDocx?.activeEditor?.doc", timeout=60000)
        await page.wait_for_timeout(2500)
        n_after = await page.evaluate("async () => (await window.__mirzaDocx.activeEditor.doc.trackChanges.list({})).total")
        rec("docx export/reopen keeps tracked changes", n_after == n_before and n_after > 0, f"{n_before}->{n_after}")
        await page.evaluate("async () => window.__harness.docx().rejectAllChanges()")
        txt = await page.evaluate("async () => window.__harness.docx().getText()")
        rec("reject all restores original text", "ten (10) business days" in txt and "Time is of the essence" not in txt, txt[:120].replace("\n"," | "))
        r2 = await page.evaluate("""async () => window.__harness.docx().applyProposal({kind:'word', summary:'s', edits:[{op:'replace', find:'[[Closing Date]]', replace:'June 30, 2026'}]})""")
        await page.evaluate("async () => window.__harness.docx().acceptAllChanges()")
        txt2 = await page.evaluate("async () => window.__harness.docx().getText()")
        rec("accept all keeps the change", r2.get("ok") and "June 30, 2026" in txt2 and "[[Closing Date]]" not in txt2)

        # ---- Sheet
        noop = await page.evaluate("""async () => { const o = window.__harness.originals().xlsx; const e = await window.__harness.sheet().export();
          const [a,b] = await Promise.all([o.arrayBuffer(), e.arrayBuffer()]); if (a.byteLength!==b.byteLength) return false; const x=new Uint8Array(a), y=new Uint8Array(b); return x.every((v,i)=>v===y[i]); }""")
        rec("xlsx no-op export is the exact original bytes", noop)
        s = await page.evaluate("""async () => window.__harness.sheet().applyProposal({kind:'sheet', summary:'s', ops:[
          {sheet:'Parcels', cell:'A2', type:'text', value:'00123'},
          {sheet:'Parcels', cell:'B2', type:'text', value:'=not a formula'},
          {sheet:'Deal', cell:'B5', type:'formula', value:'=B4*2'},
          {sheet:'Deal', cell:'C2', type:'number', value:'42'},
          {sheet:'Deal', cell:'A1', type:'keep', value:'', bold:true, fill:'#ffcc00'}]})""")
        rec("sheet typed batch applied across two sheets", s.get("ok"), json.dumps(s))
        bad = await page.evaluate("""async () => window.__harness.sheet().applyProposal({kind:'sheet', summary:'s', ops:[
          {sheet:'Deal', cell:'C3', type:'number', value:'7'}, {sheet:'Nope', cell:'A1', type:'text', value:'x'}]})""")
        c3 = await page.evaluate("""async () => (await window.__harness.sheet().getWorkbook()).sheets.find(s=>s.name==='Deal').cells['C3'] ?? null""")
        rec("unknown sheet rejects whole batch (no partial write)", not bad.get("ok") and c3 is None, bad.get("reason",""))
        wbk = await page.evaluate("async () => window.__harness.sheet().getWorkbook()")
        parcels = next(x for x in wbk["sheets"] if x["name"]=="Parcels")["cells"]
        rec("00123 kept as text", parcels.get("A2",{}).get("v")=="00123", json.dumps(parcels.get("A2")))
        rec("'=literal' kept as text, no formula", parcels.get("B2",{}).get("v")=="=not a formula" and not parcels.get("B2",{}).get("f"), json.dumps(parcels.get("B2")))
        sel = await page.evaluate("""async () => { const api = window.__harness; return 'ok' }""")
        exp = await page.evaluate("""async () => { const b = await window.__harness.sheet().export(); window.__xl = b; const ab = await b.arrayBuffer();
          const ExcelJS = (await import('/node_modules/.vite/deps/exceljs.js')).default ?? (await import('/node_modules/.vite/deps/exceljs.js'));
          return ab.byteLength }""")
        reo = await page.evaluate("""async () => { const office = await window.__harness.office(); const d = await office.xlsxToWorkbook(await window.__xl.arrayBuffer(), 'x.xlsx');
          const cell = (n,r,c) => { const id = d.sheetOrder.find(i=>d.sheets[i].name===n); return d.sheets[id].cellData[r]?.[c] ?? null };
          return { a2: cell('Parcels',1,0), b5: cell('Deal',4,1), b4: cell('Deal',3,1), a1: cell('Deal',0,0), a1s: (()=>{const c=cell('Deal',0,0); return c && typeof c.s==='string' ? d.styles[c.s] : c?.s})() } }""")
        rec("export+reopen: 00123 text, new formula, untouched formula, bold+fill", 
            reo["a2"] and reo["a2"].get("v")=="00123" and reo["b5"] and reo["b5"].get("f")=="=B4*2" and reo["b4"].get("f")=="=SUM(B2:B3)" and (reo["a1s"] or {}).get("bl")==1,
            json.dumps(reo))
        await page.screenshot(path=str(SHOTS/"3_sheet.png"))

        # ---- Save conflict at the network boundary
        hits = {"upload": [], "rpc": 0, "delete": []}
        async def storage(route):
            req = route.request
            if req.method in ("POST","PUT"): hits["upload"].append(req.url); await route.fulfill(status=200, content_type="application/json", body=json.dumps({"Key":"x"}))
            elif req.method == "DELETE": hits["delete"].append(req.post_data or req.url); await route.fulfill(status=200, content_type="application/json", body="[]")
            else: await route.continue_()
        async def rpc(route):
            hits["rpc"] += 1
            await route.fulfill(status=400, content_type="application/json", body=json.dumps({"code":"40001","message":"conflict: file changed since it was opened"}))
        await page.route("**/storage/v1/object/**", storage)
        await page.route("**/rest/v1/rpc/save_file_version", rpc)
        conf = await page.evaluate("""async () => { const o = await window.__harness.office(); try { await o.saveNewVersion({id:'00000000-0000-0000-0000-000000000001', name:'synthetic.xlsx', matter_id:null}, 'firm/old.xlsx', new Blob(['x'])); return 'saved' } catch (e) { return e.name + ': ' + e.message } }""")
        rec("save conflict -> SaveConflict, upload removed, no overwrite", conf.startswith("SaveConflict") and len(hits["upload"])==1 and hits["rpc"]==1 and len(hits["delete"])==1, f"{conf[:60]} uploads={len(hits['upload'])} deletes={len(hits['delete'])}")

        # ---- Panel: proposal card apply-once, error+retry, Stop
        calls = {"n": 0}
        async def assist(route):
            calls["n"] += 1
            n = calls["n"]
            if n == 1:
                body = "\n".join(json.dumps(e) for e in [
                  {"t":"activity","id":"a1","label":"Searching the document","status":"running"},
                  {"t":"activity","id":"a1","status":"done"},
                  {"t":"proposal","proposal":{"kind":"word","summary":"Fill closing date","edits":[{"op":"replace","find":"business days","replace":"Business Days"}]},"validation":{"ok":True,"errors":[]}},
                  {"t":"delta","text":"Proposed one edit. For your review: confirm."},
                  {"t":"done","usage":{"inputTokens":10,"outputTokens":5},"runId":None,"steps":2}]) + "\n"
                await route.fulfill(status=200, content_type="application/x-ndjson", body=body)
            elif n == 2:
                await route.fulfill(status=503, content_type="application/json", body=json.dumps({"message":"The AI service is busy. Try again shortly.","retryable":True}))
            else:
                await route.fulfill(status=200, content_type="application/x-ndjson", body=json.dumps({"t":"delta","text":"Second try ok."})+"\n"+json.dumps({"t":"done","usage":{},"runId":None})+"\n")
        await page.route("**/api/assist", assist)
        box = page.get_by_label("Drafting request")
        await box.fill("Capitalise business days"); await box.press("Enter")
        apply = page.get_by_role("button", name="Apply as tracked changes")
        await apply.wait_for(timeout=15000)
        await apply.dblclick()
        await page.get_by_text("tracked change", exact=False).first.wait_for(timeout=15000)
        await page.wait_for_timeout(500)
        applied_btn = await page.get_by_role("button", name="Applied").count()
        tc2 = await page.evaluate("async () => (await window.__mirzaDocx.activeEditor.doc.trackChanges.list({})).total")
        rec("panel: proposal applied once as tracked change, button locked", applied_btn==1 and tc2>=1, f"tracked={tc2}")
        await box.fill("Another request"); await box.press("Enter")
        await page.get_by_text("The AI service is busy").wait_for(timeout=15000)
        retry = page.get_by_role("button", name="Retry")
        rec("panel: error shown with Retry", await retry.count()==1)
        await retry.click()
        await page.get_by_text("Second try ok.").wait_for(timeout=15000)
        rec("panel: retry succeeds as new request", True)
        await page.screenshot(path=str(SHOTS/"4_panel.png"))
        # Stop: a stream that never ends
        await page.unroute("**/api/assist")
        async def hang(route):
            await asyncio.sleep(30); 
            try: await route.abort()
            except Exception: pass
        await page.route("**/api/assist", hang)
        await box.fill("long one"); await box.press("Enter")
        stop = page.get_by_role("button", name="Stop"); await stop.wait_for(timeout=10000); await stop.click()
        await page.get_by_text("Stopped.").first.wait_for(timeout=10000)
        rec("panel: Stop ends the request", True)
        # mobile width layout of the panel
        await page.set_viewport_size({"width": 390, "height": 844})
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(SHOTS/"5_mobile.png"))
        rec("no uncaught page errors", not errs, "; ".join(errs[:3]))
        await b.close()
    Path("/tmp/browser/office/results.json").write_text(json.dumps(R, indent=1))
asyncio.run(main())
