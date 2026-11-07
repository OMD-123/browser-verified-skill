import { PlanLock, createPlan } from '../src/safety/planlock.js';

const lock = new PlanLock();
lock.set(
  createPlan({
    goal: 'test',
    successCondition: { type: 'text_visible', text: 'Signed in' },
    allowedOrigins: ['http://127.0.0.1:3999'],
    allowedActionClasses: ['read', 'navigate', 'submit'],
    maxSteps: 10,
    createdAt: new Date().toISOString(),
  }),
);

for (const url of [
  'http://127.0.0.1:3999/pages/random-classes.html',
  'http://localhost:3999/pages/random-classes.html',
]) {
  const decision = lock.check({
    actionClass: 'submit',
    currentUrl: url,
  });
  console.log(url, '->', JSON.stringify(decision));
}
