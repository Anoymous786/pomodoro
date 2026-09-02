"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Flame,
  LayoutDashboard,
  ListTodo,
  Map,
  Plus,
} from "lucide-react";
import { usePomodoro } from "@/hooks/usePomodoro";
import { practiceWindow } from "@/lib/practice";

export type NavId = "dashboard" | "tasks" | "roadmaps" | "activity";

const NAV_ITEMS: {
  id: NavId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  section?: string;
}[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, section: "" },
  { id: "tasks", label: "Tasks", icon: ListTodo, section: "section-practice" },
  { id: "roadmaps", label: "Roadmaps", icon: Map, section: "section-roadmaps" },
  { id: "activity", label: "Activity", icon: Flame, section: "section-activity" },
];

const MOBILE_ITEMS = [...NAV_ITEMS];

const WIDE = "w-[248px] min-w-[232px]";
const NARROW = "w-[56px]";

/**
 * ChatGPT-style persistent sidebar.
 *
 * PRACTICE      Dashboard · Tasks · Roadmaps · Activity · History
 * RECENT TASKS  Django · Spring Boot · Python · React   (click -> workspace)
 *               [ + New Task ]
 *
 * Self-contained: reads saved tasks from usePomodoro() and the current
 * route via usePathname(). The active task workspace (by route
 * `/task/:id`) is highlighted. All time/roadmap state lives on the task
 * object, so this rail never leaks another task's content.
 *
 * `onOpenHistory` is optional: the dashboard passes its own History-modal
 * opener; task workspaces omit it and the History nav item simply
 * navigates back to the dashboard.
 */
export interface NavRailProps {
  /** @deprecated History is accessed via the left sidebar, not a nav item. */
  onOpenHistory?: () => void;
}

export default function NavRail(_props: NavRailProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { practiceTasks, hydrated } = usePomodoro();

  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem("habeet:navRail") === "1") setCollapsed(true);
    } catch {}
  }, []);

  const toggle = () =>
    setCollapsed((v) => {
      try {
        window.localStorage.setItem("habeet:navRail", v ? "0" : "1");
      } catch {}
      return !v;
    });

  // Active task workspace (route /task/:id). /task/new is the blank slate.
  const taskMatch = pathname.match(/^\/task\/([^/]+)/);
  const activeTaskId = taskMatch?.[1] ?? null;
  const isBlank = pathname === "/task/new";

  const goSection = (id: NavId, section?: string) => {
    const scroll = () => {
      if (!section) return window.scrollTo({ top: 0, behavior: "smooth" });
      document
        .getElementById(section)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    if (pathname === "/") {
      scroll();
    } else {
      router.push("/");
      window.setTimeout(scroll, 350);
    }
  };

  const recentTasks = hydrated ? (practiceTasks ?? []) : [];

  return (
    <aside
      data-testid="nav-rail"
      className={`relative z-20 hidden h-screen flex-col overflow-y-auto overflow-x-hidden border-r border-white/5 bg-surface-raised py-3 transition-[width] duration-200 lg:flex ${
        collapsed ? NARROW : WIDE
      }`}
    >
      {/* Collapse toggle */}
      <button
        onClick={toggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        data-testid="nav-collapse"
        className="absolute -right-2 top-7 -translate-x-full rounded-full border border-white/10 bg-surface p-1 text-gray-400 opacity-60 hover:border-white/20 hover:text-gray-200"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronLeft className="h-3.5 w-3.5" />
        )}
      </button>

      <div className="flex-1 overflow-y-auto">
        {/* PRACTICE */}
        <nav aria-label="Primary" className="px-2.5 pb-4">
          <p
            className={`px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500 ${
              collapsed ? "sr-only" : ""
            }`}
          >
            Practice
          </p>
          <ul className="flex flex-col gap-0.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <button
                    onClick={() => goSection(item.id, item.section)}
                    data-testid={`nav-${item.id}`}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-gray-300 outline-none transition focus-visible:ring-2 focus-visible:ring-habeet-400 hover:bg-white/5 hover:text-gray-100 ${
                      collapsed ? "justify-center px-2" : ""
                    }`}
                    title={item.label}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className={collapsed ? "sr-only" : ""}>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
                </nav>

        {/* RECENT TASKS */}
        <div className="px-2.5">
          <p
            className={`px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500 ${
              collapsed ? "sr-only" : ""
            }`}
          >
            Recent tasks
          </p>
          {collapsed ? (
            <div className="flex flex-col items-center gap-1.5 py-1">
              <button
                onClick={() => router.push("/task/new")}
                data-testid="nav-new-task"
                aria-label="New Task"
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-habeet-500 text-white outline-none transition hover:bg-habeet-400 focus-visible:ring-2 focus-visible:ring-habeet-400"
                title="New Task"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          ) : recentTasks.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-gray-500">No tasks yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {recentTasks.map((t) => {
                const active = t.id === activeTaskId && !isBlank;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => router.push(`/task/${t.id}`)}
                      data-testid={`nav-task-${t.id}`}
                      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-habeet-400 ${
                        active
                          ? "bg-habeet-500/15 text-habeet-100 ring-1 ring-habeet-500/40"
                          : "text-gray-300 hover:bg-white/5 hover:text-gray-100"
                      }`}
                      title={t.name}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          practiceWindow(t).status === "Completed"
                            ? "bg-emerald-400"
                            : "bg-habeet-400"
                        }`}
                      />
                      <span className="truncate">{t.name}</span>
                      {active && (
                        <span className="ml-auto text-[10px] text-habeet-300">●</span>
                      )}
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  onClick={() => router.push("/task/new")}
                  data-testid="nav-new-task"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-gray-300 outline-none transition hover:bg-white/5 hover:text-gray-100"
                >
                  <Plus className="h-4 w-4" />
                  <span>New Task</span>
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * Mobile bottom navigation bar. Used by the dashboard; kept here so the
 * navigation surface stays consistent across the app. §8: History is not
 * a nav destination — task history lives in the left sidebar.
 */
export function BottomNav() {
  const router = useRouter();
  const pathname = usePathname() ?? "";

  const base =
    "flex-1 rounded-xl flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium";

  return (
    <div
      data-testid="bottom-nav"
      className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around gap-1 bg-surface/80 p-2 shadow-lg ring-1 ring-white/5 sm:hidden"
    >
      {MOBILE_ITEMS.map((item) => {
        const Icon = item.icon;
        const active =
          item.id === "dashboard"
            ? pathname === "/"
            : pathname.startsWith("/task") && item.id === "tasks";
        return (
          <button
            key={item.id}
            data-testid={`bottomnav-${item.id}`}
            onClick={() => {
              if (pathname === "/") {
                if (item.section) {
                  document
                    .getElementById(item.section)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                } else {
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }
              } else {
                router.push("/");
                window.setTimeout(() => {
                  if (item.section) {
                    document
                      .getElementById(item.section)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                }, 350);
              }
            }}
            className={`${base} ${
              active ? "text-habeet-100" : "text-gray-500 hover:text-gray-200"
            }`}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

