import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogoMark } from "@/components/LogoMark";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Mirza" },
      { name: "description", content: "Sign in to your firm's Mirza workspace." },
      { property: "og:title", content: "Sign in — Mirza" },
      { property: "og:description", content: "Sign in to your firm's Mirza workspace." },
    ],
  }),
  component: AuthPage,
});

type Mode = "in" | "up" | "forgot" | "reset";

function friendly(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password don't match.";
  if (m.includes("email not confirmed"))
    return "Please confirm your email first — check your inbox for the link.";
  if (m.includes("already registered"))
    return "An account with this email already exists. Sign in instead.";
  if (m.includes("password should be")) return "Use at least 8 characters for the password.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts. Please wait a minute and try again.";
  return msg;
}

function AuthPage() {
  const [mode, setMode] = useState<Mode>("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();

  // Already signed in (or arriving from a password-reset link) → go to the right place.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("type=recovery")) setMode("reset");
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setMode("reset");
    });
    supabase.auth.getSession().then(({ data: s }) => {
      if (s.session && !hash.includes("type=recovery")) navigate({ to: "/today" });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/today" });
      } else if (mode === "up") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth`, data: { full_name: name } },
        });
        if (error) throw error;
        if (data.session) navigate({ to: "/today" });
        else setNotice("Check your email to confirm your account, then sign in.");
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth`,
        });
        if (error) throw error;
        setNotice("If that email has an account, a reset link is on its way.");
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        toast.success("Password updated");
        navigate({ to: "/today" });
      }
    } catch (err) {
      toast.error(friendly((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "in"
      ? "Sign in"
      : mode === "up"
        ? "Create account"
        : mode === "forgot"
          ? "Reset password"
          : "Choose a new password";

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <LogoMark className="h-10 w-10" />
          <div>
            <h1 className="text-xl font-semibold">Mirza</h1>
            <p className="text-xs text-muted-foreground">Your firm's matters, in one place</p>
          </div>
        </div>
        {notice ? (
          <div className="space-y-4 text-sm">
            <p>{notice}</p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setNotice(null);
                setMode("in");
              }}
            >
              Back to sign in
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" aria-label={title}>
            <h2 className="text-sm font-semibold">{title}</h2>
            {mode === "up" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Full name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                />
              </div>
            )}
            {mode !== "reset" && (
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
            )}
            {mode !== "forgot" && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">{mode === "reset" ? "New password" : "Password"}</Label>
                  {mode === "in" && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setMode("forgot")}
                    >
                      Forgot?
                    </button>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "in"
                  ? "Sign in"
                  : mode === "up"
                    ? "Create account"
                    : mode === "forgot"
                      ? "Send reset link"
                      : "Update password"}
            </Button>
            {mode !== "reset" && (
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setMode(mode === "in" ? "up" : "in")}
              >
                {mode === "in"
                  ? "New to Mirza? Create an account"
                  : mode === "up"
                    ? "Already have an account? Sign in"
                    : "Back to sign in"}
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
