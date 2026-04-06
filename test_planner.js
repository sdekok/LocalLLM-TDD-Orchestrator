import { ModelRouter } from './dist/llm/model-router.js';
import { planProject } from './dist/agents/project-planner.js';

async function main() {
  const router = new ModelRouter();
  const cwd = process.cwd();
  await planProject("Build a simple calculator", router, cwd, {
    input: async () => null,
    notify: console.log,
    editor: async () => null,
    confirm: async () => true
  });
}
main();
