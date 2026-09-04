import { analyzeGithubRepository } from "./repo-analyzer.js";

const repository = process.argv[2];

if (!repository) {
  console.error("A repository URL is required.");
  process.exit(1);
}

try {
  process.stdout.write(JSON.stringify(analyzeGithubRepository(repository)));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

