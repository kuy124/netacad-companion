# MeowCad Solver

**Less clicking. Clearer controls. Smarter NetAcad chapter checklists.**

> Heavily based on and inspired by **[ingui-n/netacad-solver](https://github.com/ingui-n/netacad-solver)**.
> The original auto-solver and its DOM/interception foundation deserve the credit.
> This is an independently maintained derivative, not an official Cisco extension.

## Download and start

**[Latest release →](https://github.com/kuy124/meowcad-solver/releases/latest)**

| Browser | Download | Install |
| --- | --- | --- |
| Chrome, Edge, Brave, Vivaldi | `meowcad-solver-v0.1.0-chromium.zip` | Extract → open `chrome://extensions` → enable Developer mode → **Load unpacked** → select the extracted folder containing `manifest.json`. |
| Firefox 128+ | `meowcad-solver-v0.1.0-firefox.xpi` | Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → select the XPI. |

The Firefox download is **unsigned** and temporary: it unloads when Firefox closes.
Permanent Firefox installation requires Mozilla signing. These packages are not
Chrome Web Store or Firefox Add-ons store releases. Respect your organization's
browser policies; do not bypass blocked installation settings.

## Pick your mode

- **Easy — default:** highlights available answers. **Select answers** or `Ctrl+Shift+Y`
  selects them; you review and submit yourself.
- **Brutal:** automatically selects and submits supported questions. Switching to
  Brutal can submit the current question immediately.

Open the bottom-right **NetAcad Solver** control to switch modes. `Escape` collapses it.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+Y` | Select available correct answers |
| `Ctrl+Shift+H` | Show/hide answer highlights |
| `Ctrl+Shift+M` | Switch Easy/Brutal |

Repeated selection does not toggle already-selected answers off. Matching pairs
and accordion headers use distinct highlight colors.

## Automate a chapter

1. Open your course at [netacad.com](https://www.netacad.com/) with **Course Outline** visible.
2. Choose **Easy** → expand **Chapter checklist** → refresh the chapter list if needed.
3. Check a chapter, such as **Module 12**, and press **Start**.
4. Keep the course tab open. **Stop** cancels the run.

The default pace is **0.2 seconds**, adjustable down to 0.1 seconds.

- Reads plain text in section order, including long/nested readers and revealed text.
- Opens supported tabs/reveals without cycling endlessly through rerendered controls.
- **Skip videos:** activates lazy Play overlays and seeks to the last moment of native
  videos, letting the real ended event run. Disable the option for full playback.
- **Open documents:** visits PDF/Office/text links and native **description/instructions**
  buttons, waits for the temporary tab to load, closes it, and returns to the course.
- Retries only unfinished activities once. Unconfirmed items stay listed as pending.
- Uses NetAcad's completion indicators, not invented completion records.

> **Starting the checklist permits supported self-check submissions in Easy mode.**
> It does not enable Brutal mode. Mode changes are disabled while a checklist runs.

Graded quizzes/exams, external exercises, projects, and locked activities remain
manual. Opening a lab's instruction PDF does **not** perform the lab. Unsupported
controls, restricted players, cross-origin content, and missing answer data can
also require manual work. Video transcripts/player settings are not clicked by
the generic activity pass. A reading topic being visited does not prove that its
graded quiz is finished.

**Stop closes only the document tab tracked for the current visit.** It does not
cancel downloads already started by your browser. Changing course pages or closing
the course cancels the current run. Your authentication is handled by NetAcad;
the extension does not provide a login service.

## Build and check

Use Node.js **22.18+ (22.x)** or **24.11+** and npm.

```sh
npm ci
npm run build             # Chromium build: dist/
npm run build:firefox     # Firefox build: dist-firefox/
npm run package           # Release archives: release/
npm test                  # Solver logic/stress checks
npm run test:browser      # Real Chromium regression checks
npm run test:documents    # Document ownership and cleanup checks
npm run test:packages     # Archive contents, manifests and CRC checks
```

Browser tests need [Playwright](https://playwright.dev/) and its Chromium browser
available locally. They otherwise skip with a message. Build folders, release
archives, screenshots, browser sessions, and machine-specific diagnostic scripts
are not committed.

## Credits and limitations

**Primary inspiration and original solver foundation:**
[ingui-n/netacad-solver](https://github.com/ingui-n/netacad-solver).
Please visit and support the original project. Attribution is not a substitute
for a license: upstream declares no license, and this repository does not relicense
its code. See **[NOTICE.md](NOTICE.md)**.

Public course-navigation research also used
[NetAIcad](https://github.com/misterzaidxpy/NetAIcad) and
[netacad-automation](https://github.com/yadavsaurabh1/netacad-automation).
The checklist targets the English, numbered Course Outline and readable course
frames; it is not an official Cisco completion API.

Live Chrome testing confirmed Module 13 reading/document completion indicators
at **95%**, with the graded module quiz left manual. This is a compatibility
observation, not a guarantee for every course or renderer.

**[Changelog](CHANGELOG.md) · [Report an issue](https://github.com/kuy124/meowcad-solver/issues)**
