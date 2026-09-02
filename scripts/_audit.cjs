const fs = require("fs");
const L = fs.readFileSync("hooks/usePomodoro.ts", "utf8").split(/\n/);
const needles = [
  "completeStep", "finishStepTimer", "startStepTimer", "reopenStepTimer",
  "dayUnlockState", "taskAssessment", "completeStepCascade",
  "startDayAssessment", "submitDayAssessment", "startFinalExam",
  "saveExamDraft", "submitFinalExam", "setDayAssessmentPending",
  "setActiveExam", "setPendingRoadmapExam", "isTaskAutoCompleted",
  "syncCompletedDays", "dayAssessmentPending", "activeExam",
  "STEP_QUESTION_PENDING", "QUESTION_SUBMITTED", "FINISH_REQUESTED",
  "assessment_ready", "assessment_in_progress"
];
for (const n of needles) {
  const idx = L.findIndex((l) => l.includes(n));
  if (idx >= 0) console.log((idx+1)+": "+L[idx].trim().slice(0,160));
  else console.log("MISSING: "+n);
}
