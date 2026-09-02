/**
 * lib/demo-fixture.ts — §P6 Demo Mode.
 * A fully populated, static local fixture (no LLM call, no network) so live
 * demos can showcase the app instantly. Visible only behind a dev/demo flag.
 */
import type {
  Badge,
  PracticeTask,
  PomodoroAppState,
  RoadmapExamResult,
  RoadmapStep,
  SkillProfile,
} from "./types";
import { createEmptyState } from "./storage";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function makeDemoSteps(): RoadmapStep[] {
  return [
    { id: "d1", title: "React basics: components & JSX", dayNumber: 1, isDone: true, completedAt: NOW - 6 * DAY, practicedSeconds: 32 * 60, elapsedSeconds: 0, timerStatus: "idle", checkIn: { question: "What is JSX?", options: ["A JS template syntax", "A JSON format", "A database", "A CLI tool"], answer: "A JS template syntax", correct: true, passed: true, answeredAt: NOW - 6 * DAY, explanation: "JSX is a syntax extension that lets you write HTML-like markup inside JavaScript.", difficulty: "easy" } },
    { id: "d2", title: "Props & state fundamentals", dayNumber: 1, isDone: true, completedAt: NOW - 5 * DAY, practicedSeconds: 28 * 60, elapsedSeconds: 0, timerStatus: "idle", checkIn: { question: "When does a component re-render?", options: ["When props or state change", "Never", "On page refresh", "Every 5 seconds"], answer: "When props or state change", correct: true, passed: true, answeredAt: NOW - 5 * DAY, explanation: "React re-renders a component when its props or state change.", difficulty: "medium" } },
    { id: "d3", title: "Hooks: useState & useEffect", dayNumber: 2, isDone: true, completedAt: NOW - 4 * DAY, practicedSeconds: 40 * 60, elapsedSeconds: 0, timerStatus: "idle", checkIn: { question: "What does useEffect do?", options: ["Runs side effects in function components", "Creates a database", "Renders HTML", "Defines types"], answer: "Runs side effects in function components", correct: true, passed: true, answeredAt: NOW - 4 * DAY, explanation: "useEffect lets you run side effects (data fetching, subscriptions) after render.", difficulty: "medium" } },
    { id: "d4", title: "Event handling & forms", dayNumber: 2, isDone: false, practicedSeconds: 8 * 60, elapsedSeconds: 0, timerStatus: "idle" },
    { id: "d5", title: "Component lifecycle & patterns", dayNumber: 3, isDone: false, practicedSeconds: 0, elapsedSeconds: 0, timerStatus: "idle" },
    { id: "d6", title: "React Router basics", dayNumber: 3, isDone: false, practicedSeconds: 0, elapsedSeconds: 0, timerStatus: "idle" },
  ];
}

function demoSkillProfiles(): Record<string, SkillProfile> {
  return {
    react: {
      topic: "react",
      label: "React",
      score: 72,
      questionsAttempted: 8,
      correct: 6,
      total: 12,
      examsTaken: 1,
      lastUpdated: NOW - 2 * DAY,
    },
    "react-router": {
      topic: "react-router",
      label: "React Router",
      score: 45,
      questionsAttempted: 2,
      correct: 1,
      total: 4,
      examsTaken: 0,
      lastUpdated: NOW - 2 * DAY,
    },
  };
}

function demoExamResult(): RoadmapExamResult {
  return {
    score: 14,
    pct: 70,
    total: 20,
    passed: true,
    breakdown: { react: { correct: 8, total: 10 }, "react-router": { correct: 3, total: 5 }, hooks: { correct: 3, total: 5 } },
    answers: { q1: "A JS template syntax", q2: "When props or state change" },
    gradedAt: NOW - 1 * DAY,
  };
}

/** Builds a fully-populated demo state from pure fixtures. No LLM/network. */
export function buildDemoState(): PomodoroAppState {
  const base = createEmptyState();

  const demoTask: PracticeTask = {
    id: "demo-react-roadmap",
    name: "Learn React in 7 days",
    description: "Demo task — a partially-completed React roadmap.",
    startDate: new Date(NOW - 4 * DAY).toISOString().slice(0, 10),
    durationDays: 7,
    checkIns: [1, 2],
    roadmap: makeDemoSteps(),
    is_completed: false,
    createdAt: NOW - 4 * DAY,
  };

  const demoTask2: PracticeTask = {
    id: "demo-js-refresh",
    name: "JavaScript Fundamentals Refresher",
    description: "Demo task — quick JS fundamentals recap.",
    startDate: new Date(NOW - 2 * DAY).toISOString().slice(0, 10),
    durationDays: 3,
    checkIns: [1],
    roadmap: [
      { id: "j1", title: "Closures & scope", dayNumber: 1, isDone: true, practicedSeconds: 25 * 60, elapsedSeconds: 0, timerStatus: "idle", checkIn: { question: "What is a closure?", options: ["A function with its lexical scope", "A class instance", "A data type", "An API"], answer: "A function with its lexical scope", correct: true, passed: true, answeredAt: NOW - 2 * DAY, explanation: "A closure is a function bundled with its lexical environment.", difficulty: "medium" } },
      { id: "j2", title: "Promises & async/await", dayNumber: 2, isDone: false, practicedSeconds: 0, elapsedSeconds: 0, timerStatus: "idle" },
      { id: "j3", title: "Array methods (map/filter/reduce)", dayNumber: 2, isDone: false, practicedSeconds: 0, elapsedSeconds: 0, timerStatus: "idle" },
    ],
    is_completed: false,
    createdAt: NOW - 2 * DAY,
  };

  const badge: Badge = {
    id: "badge-1",
    title: "React Foundations",
    icon: "⚛️",
    unlockedAt: NOW - 3 * DAY,
  };

  return {
    ...base,
    activeDate: base.activeDate,
    practiceTasks: [demoTask, demoTask2],
    skillProfiles: demoSkillProfiles(),
    roadmapExamResults: { "demo-react-roadmap": demoExamResult() },
    badges: [badge],
    history: {
      [base.activeDate]: {
        date: base.activeDate,
        sessions_count: 4,
        focus_minutes: 92,
        tasks_completed: 2,
        total_tasks: 4,
        productivity: 62,
      },
    },
  };
}