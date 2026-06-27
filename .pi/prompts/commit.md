---
description: Commit current work, describe unrelated changes, and report Briefkit version
argument-hint: "[comments]"
model: openai-codex/gpt-5.5
thinking: low
---
Safely commit all changes related to what you were working on, describe any uncommitted changes related to other projects.

Also print the current Briefkit package version from `package.json` in your final response.

Comments: $ARGUMENTS

Current package version:
```
!`node -p "require('./package.json').version"`
```

Current git status:
```
!`git status --short`
```
