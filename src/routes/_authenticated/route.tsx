import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { Briefcase, CalendarCheck, Users, Files, FileText, Settings, LogOut, Scale } from "lucide-react";
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
  { to: "/library", label: "Library", icon: Scale },
] as const;

function Shell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const item = (active: boolean) =>
    `flex min-w-11 flex-col items-center gap-1 rounded px-1 py-1.5 text-[10px] font-medium transition-colors md:w-14 ${
      active
        ? "bg-primary/8 text-primary"
        : "text-muted-foreground hover:bg-raised hover:text-foreground"
    }`;
  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <aside className="sticky top-0 z-20 flex shrink-0 items-center gap-1 border-b bg-rail px-2 py-2 md:h-screen md:w-16 md:flex-col md:border-b-0 md:border-r md:px-1 md:py-4">
        <Link to="/today" className="mb-0 mr-1 md:mb-5 md:mr-0" aria-label="Mirza home">
          <LogoMark className="h-8 w-8 rounded" />
        </Link>
        <nav className="flex flex-1 gap-0.5 sm:gap-1 md:flex-col" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={item(path.startsWith(n.to))} aria-label={n.label}>
              <n.icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
              <span className="hidden sm:inline">{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="flex gap-0.5 sm:gap-1 md:flex-col">
          <Link to="/settings" className={item(path.startsWith("/settings"))} aria-label="Settings">
            <Settings className="h-[18px] w-[18px]" strokeWidth={1.8} />
            <span className="hidden sm:inline">Settings</span>
          </Link>
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/auth" });
            }}
            className={item(false)}
            aria-label="Sign out"
          >
            <LogOut className="h-[18px] w-[18px]" strokeWidth={1.8} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
