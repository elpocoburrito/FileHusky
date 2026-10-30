When working on a feature, you will save important parts of your context in a project.md file at the root of the project. That file will contain details about the project, the various features it has and other noteworthy details.
This file should work like a commit system, where you append information but do not replace old information unless necessary. "Commits" will be delimited by lines of ----
If the file doesn't exist, you will look through the project code, and through the git repo, if there is one, to build an initial commit.

## Committing work

When a feature (or a coherent chunk of work) reaches a good stopping point — it is implemented and verified, and you are about to move on to something else or hand back to the user — commit it before continuing.

- Separate commits by feature. Do not bundle unrelated changes into one commit, and do not leave finished features uncommitted while starting new ones.
- Stage only the changes that belong to that feature. When several features are mixed in the same file, stage them hunk-by-hunk (or line-by-line) so each commit stays focused.
- Use a short imperative subject and a bullet body (see the existing git history for style).
- Never commit runtime/generated artifacts: `.pi/`, `data/`, `node_modules/`, `tmp/`, logs, and other files covered by `.gitignore`.
- Do not commit half-finished, broken, or unverified work.

If you are in doubt about whether something is ready to commit — the scope of a feature, how to split overlapping changes, or whether the user still wants the change — ask the user for confirmation first instead of committing.
