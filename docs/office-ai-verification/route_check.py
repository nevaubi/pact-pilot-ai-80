import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright
S = Path("/tmp/browser/office/screenshots")
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1024, "height": 800})
        pg = await ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        cookies = os.environ.get("LOVABLE_BROWSER_SUPABASE_COOKIES_JSON")
        if cookies:
            cs = json.loads(cookies)
            for c in cs: c["url"]="http://localhost:8080"
            await ctx.add_cookies(cs)
        await pg.goto("http://localhost:8080/")
        await pg.evaluate(f"localStorage.setItem({json.dumps(os.environ['LOVABLE_BROWSER_SUPABASE_STORAGE_KEY'])}, {json.dumps(os.environ['LOVABLE_BROWSER_SUPABASE_SESSION_JSON'])})")
        await pg.goto("http://localhost:8080/office/f4ead577-2a54-4de7-be7c-e530638557a3")
        await pg.get_by_role("complementary", name="Drafting assistant").wait_for(timeout=60000)
        await pg.wait_for_timeout(4000)
        save = pg.get_by_role("button", name="Save", exact=True)
        print("save disabled when unchanged:", await save.is_disabled())
        pane = await pg.get_by_role("complementary", name="Drafting assistant").bounding_box()
        print("1024px: panel width", round(pane["width"]), "editor width", round(pane["x"]))
        await pg.screenshot(path=str(S/"6_route_1024.png"))
        await pg.set_viewport_size({"width": 390, "height": 844}); await pg.wait_for_timeout(800)
        print("mobile: panel visible after resize:", await pg.get_by_role("complementary", name="Drafting assistant").count())
        await pg.get_by_label("Toggle drafting assistant").click(); await pg.wait_for_timeout(600)
        bb = await pg.get_by_role("complementary", name="Drafting assistant").bounding_box()
        print("mobile drawer box:", {k: round(v) for k,v in bb.items()})
        await pg.screenshot(path=str(S/"7_route_mobile.png"))
        print("errors:", errs[:3])
        await b.close()
asyncio.run(main())
