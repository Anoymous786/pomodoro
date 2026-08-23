"use client";

import { useMemo, useState } from "react";
import { History } from "lucide-react";
import { usePomodoro } from "@/hooks/usePomodoro";
import Timer from "@/components/Timer";
import TaskManager from "@/components/TaskManager";
import Dashboard from "@/components/Dashboard";
import HistoryModal from "@/components/HistoryModal";
import TopicBoard from "@/components/TopicBoard";
import ExamModal from "@/components/ExamModal";
import { getTodayKey } from "@/lib/storage";

export default function Home() {
  const {
    mode,
    isRunning,
    displayTime,
    remainingMs,
    durationMs,
    startTimer,
    pauseTimer,
    resetTimer,
    activeTask,
    activeTaskId,
    tasks,
    tasksCompleted,
    totalTasks,
    addTask,
    toggleTask,
    editTask,
    editTaskMinutes,
    deleteTask,
    startTask,
    todayStats,
    liveProductivity,
    history,
    roadmaps,
    badges,
    generateRoadmap,
    startDay,
    completeRoadmapDay,
    replanDay,
    updateRoadmapTaskMinutes,
    // Per-task exams
    examTaskId,
    examTask,
    attachExam,
    submitExam,
    openExam,
    dismissExam,
    activeRoadmapDay,
  } = usePomodoro();

  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * Roadmap context for the exam of a task that came from the active
   * roadmap day — keeps questions anchored to THIS task's content.
   */
  const examContext = useMemo(() => {
    if (!examTask) return undefined;
    const active = activeRoadmapDay;
    if (!active) return undefined;
    const roadmap = roadmaps.find((r) => r.id === active.roadmapId);
    const day = roadmap?.days.find((d) => d.day_number === active.dayNumber);
    if (!roadmap || !day) return undefined;
    // Confirm the examined task actually belongs to the loaded day.
    const idx = tasks.findIndex((t) => t.id === examTask.id);
    if (idx !== -1 && idx < day.tasks.length) {
      return `${roadmap.topic_name} — ${day.day_title}`;
    }
    return undefined;
  }, [examTask, activeRoadmapDay, roadmaps, tasks]);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-8 sm:px-6">
      {/* Header */}
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 sm:text-3xl">
            {"Stay focused. You've got this!"}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {getTodayKey()}
          </p>
        </div>
        <button
          onClick={() => setHistoryOpen(true)}
          className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 active:scale-95 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <History className="h-4 w-4" />
          View History
        </button>
      </header>

      {/* Focus Mode Timer */}
      <section className="mb-8 flex flex-col items-center">
        <Timer
          mode={mode}
          isRunning={isRunning}
          displayTime={displayTime}
          remainingMs={remainingMs}
          durationMs={durationMs}
          activeTaskName={activeTask?.name ?? null}
          onStart={startTimer}
          onPause={pauseTimer}
          onReset={resetTimer}
        />
      </section>

      {/* Dashboard */}
      <div className="mb-8">
        <Dashboard
          todayStats={todayStats}
          tasksCompleted={tasksCompleted}
          totalTasks={totalTasks}
          liveProductivity={liveProductivity}
        />
      </div>

      {/* AI Roadmap Generator */}
      <div className="mb-8">
        <TopicBoard
          roadmaps={roadmaps}
          badges={badges}
          onGenerate={generateRoadmap}
          onStartDay={startDay}
          onCompleteDay={completeRoadmapDay}
          onReplanDay={replanDay}
          onEditTaskMinutes={updateRoadmapTaskMinutes}
        />
      </div>

      {/* Tasks */}
      <TaskManager
        tasks={tasks}
        tasksCompleted={tasksCompleted}
        totalTasks={totalTasks}
        activeTaskId={activeTaskId}
        onAdd={addTask}
        onToggle={toggleTask}
        onEdit={editTask}
        onEditMinutes={editTaskMinutes}
        onDelete={deleteTask}
        onStartTask={startTask}
        onReviewExam={openExam}
      />

      {/* Per-task exam (opens automatically when a task is completed) */}
      {examTask && (
        <ExamModal
          task={examTask}
          context={examContext}
          onClose={dismissExam}
          onAttachQuestions={attachExam}
          onSubmitAnswers={submitExam}
        />
      )}

      {/* History Modal */}
      <HistoryModal
        open={historyOpen}
        history={history}
        onClose={() => setHistoryOpen(false)}
      />
    </main>
  );
}