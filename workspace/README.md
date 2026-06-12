# workspace/

**Drop your project folders here.** Each top-level folder becomes a project Aria
can work in.

```
workspace/
  my-saas-app/        ← clone or copy a whole project in
  client-website/
  some-experiment/
```

Then open Aria (Ctrl/⌘+K in the app), hit the rescan button in the project
picker, and select the one you want. When Aria works in a project:

- her working directory **is** that folder (so `claude` auto-loads its
  `CLAUDE.md` and relative paths resolve there), and
- the **whole workspace** is on `--add-dir`, so she can still reach sibling
  projects when you ask her to.

Pick **“All projects”** to run at the workspace root with access to everything.

Memory is **per project** (recent → mid → long), plus a **global Core** tier
shared across all of them. Nothing in this folder is committed by the
boilerplate's git — your projects keep their own git history.
