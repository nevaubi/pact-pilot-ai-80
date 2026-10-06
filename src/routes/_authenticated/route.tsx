import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { Briefcase, CalendarCheck, Users, Files, FileText, Settings, LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { LogoMark } from "@/components/LogoMark";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: Shell,
});

const NAV = [
  { to: "/today", label: "Today", icon: CalendarCheck },
  { to: "/matters", label: "Matters", icon: Briefcase },
  { to: "/contacts", label: "Contacts", icon: Users },
  { to: "/files", label: "Files", icon: Files },
  { to: "/templates", label: "Templates", icon: FileText },
] as const;

function Shell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="sticky top-0 z-20 flex shrink-0 items-center gap-1 border-b bg-rail px-2 py-2 md:h-screen md:w-[76px] md:flex-col md:border-b-0 md:border-r md:py-4">
        <Link to="/today" className="mb-0 mr-2 md:mb-4 md:mr-0">
          <LogoMark className="h-9 w-9" />
        </Link>
        <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.map((n) => {
            const active = path.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`flex min-w-[56px] flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-medium transition-colors ${
                  active ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                }`}
              >
                <n.icon className="h-5 w-5" strokeWidth={1.75} />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex gap-1 md:flex-col">
          <Link
            to="/settings"
            className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-medium ${path.startsWith("/settings") ? "bg-card text-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Settings className="h-5 w-5" strokeWidth={1.75} />
            Settings
          </Link>
          <button
            onClick={() => supabase.auth.signOut()}
            className="flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-5 w-5" strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
