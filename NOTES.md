# How to start
0. Have Node.js 24 or newer
1. Fetch the repo
2. `npm i`
3. Create the settings file from the example: `cp .env.example .env`. Change values for settings in .env if needed.
4. `npm run start`

You may remove result.md in 'eval' folder, just then run `npm run eval`. File will be recreated and it will be the same as before because the app logic is deterministic.

# General Notes
1. There was no cursor data inside the zip that I could have imported. Decided to generate synthetic Cursor data in a SQLite DB. Script to generate it: `npm run gen:cursor`. It uses a fixed "seed", so file will be exactly the same every time.
  - I haven't found any real Cursor data to import, so generating synthetic data was necessary.
  - `fixtures/cursor/state.vscdb` is generated. Cursor itself saves its chats in a SQLite database called state.vscdb.
2. I used Codex (Sol 6.1) and Claude (Opus 5.5) during the session. `Codex` when I needed something small and expected the result to pop up quicker. `Claude` when I needed more in-depth analysis or brainstorming.
3. Tech stack: node:http + strict TypeScript
4. While somebody may think the structure of the app is overly complex, it is designed this way to ensure modularity and maintainability. I asked LLM specifically to make it that way, so that I could easily `node:http` → `Hono` → `NestJS`; or `UI HTML` → `React` → `TanStack`.
5. I have TS everywhere in the project, just because it's easier to debug and understand the app.  However, since browsers understand only JavaScript, when I run `npm start`, it first runs `npm run build:web`.
6. I've added env checked. You can't start the project without variables specified (check env.example)
7. Very important: I assumed that since the app is local, there won't be any network call, so price analysis and chats decisions never leave the laptop. `core` is the brain. Thanks to layered architecture I can replace the brain and start using calls to remote services if needed in the future for more advanced capabilities (like adding Machine learning for better predictions). Right now it's all deterministic.

# How I did it (my AI workflow for this task):
1. First stop: general conversation with ChatGPT (Web) to come up with a foundation.
2. Then switched to Claude (Opus 5.5) to run /grill-me session with ideas from step 1. Every answer is recorded in DECISIONS.md and folded into SPEC.md. OTel kept as a pricing oracle.
3. Implementation was done in a new session with Claude (Opus 5.5), following PLAN.md one phase at a time, `npm run check` green.
4. I used Sol 6.1 later for smaller fixes/changes.
5. After code was ready, I used new Opus session to make a review, emulating real work when Code Rabbit reviews my PR
6. When review was done, I've reviewed the code myself marking any remaining issues or improvements.
7. Then ran another Sol session to do the fixes
8. Filled out this file with all the notes and observations from the development and review process I remembered.

# Where AI good
1. Tests generation. If i remove the calc results, change the code and run calculations again, I might get a different spending number. Tests ensure that the results remain consistent and correct.
2. I asked AI to label data automatically, without my involvement. I checked the result, think it was good.
3. The code uses SQL placeholders, also called parameterized queries. They're the standard protection against SQL injection. AI added that correctly throughout the code.
3. Introduces `sources`, e.g. translators or some sort of adapters. Each AI helper writes its diary in its own language: Claude writes lines like `{"type":"assistant","message":{...,"usage":{...}}}`; Codex writes `{"type":"response_item","payload":{"type":"function_call",...}}`; Cursor keeps entries in a database: `bubbleId:abc:123 → {...}`. So sources translates all three into one common language, so that the `core` works only with one "language" not with three. If I need to add more sources (Kimi Code logs, for example), I'll do that in `sources`.

# Where AI was wrong
1. I asked to layer the application to have every piece of functionality isolated in its own module, but the AI misunderstood and created unnecessary abstractions, made a package from everything
2. I don't think opting out `scripts` was necessary, AI could easily place it to `tools`
3. Some places in code were not effective. AI tends to create new variables unnecessarily, leading to more memory consumption
4. Some of the comments were unnecessary. They just repeat the code.
5. Quite a bunch of type casting, if tho my original prompt has a request to avoid type casting as much as possible.
6. Some approaches were not expected. For example, placing a map into a <script> tag in the HTML:
```html
<script type="importmap">
  { "imports": { "zod": "/vendor/zod/index.js", "@agentspend/contract": "/app/contract/src/index.js" } }
</script>
```
7. When I asked how to restart the repo without history, the AI told me which name and email "git is set to". That identity lived only in the old repo's `.git/config`, so deleting `.git` deleted it too, and the first commit was pushed as `unknown`. Caught by me on GitHub after the push.
8. During the CSS extraction, AI's verification script reported a difference because it compared Windows and Unix line endings. Normalizing line endings confirmed the CSS rules were unchanged.
9. The first development watcher read flags changed by callbacks across an await; lint treated later checks as constants. The required check caught this, and accessors now read those flags without that narrowing. Review also caught and corrected a log message changed by the rename.

# What I would do another day (aka improvements)
1. Opt out SQLite to Supabase (or any other cloud). With proxy, so that if there are network issues, the app can still function locally.
2. Add app network calls, so that I could receive information about how agents work and spendings remotely (aka monitoring app).
3. Add LLM + ML (scikit learn, tensor flow, etc) models for instant learning and remote evaluation, especially for live processing of OTel data.
4. I like layering, but I don't really like 'packaging'. Every part of the application is a potentialy microservice, not package. Package is OK for not, I would at very least it to 'apps' folder and introduce turborepo for better monorepo management.

In general I think this is a good candidate for a desktop application (C++, Electron, Python tkinter, Java Swing, etc) with builds for every popular OS (MacOS, Win, Debian/Ubuntu).
