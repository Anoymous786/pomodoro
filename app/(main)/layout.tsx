"use client";

import type { ReactNode } from "react";
import NavRail, { BottomNav } from "@/components/habeet/NavRail";

/**
 * Route-group shared layout for the task-centric workspaces.
 *
 * Wraps the dashboard, the blank "New Task" workspace and every task's
 * dedicated workspace (/task/[id]) with the persistent ChatGPT-style sidebar,
 * so navigation/history stays stable as the user hops between a task and its
 * roadmap timer workspace. Desktop gets the collapsible rail, mobile gets the
 * bottom navigation bar. Routes outside this group (e.g. the AI roadmap
 * generator) keep their own full-screen shell.
 */
export default function MainLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <NavRail />
      <div className="flex-1 overflow-y-auto">{children}</div>
      <BottomNav />
    </div>
  );
}
