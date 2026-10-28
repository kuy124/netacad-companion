# NetAcad Companion

A browser extension for NetAcad chapter reading, checklists and answer assistance.

Heavily based on [ingui-n/netacad-solver](https://github.com/ingui-n/netacad-solver).
Credit for the original automatic solver and DOM/interception foundation belongs
to that project. This is an independently maintained derivative, not a Cisco product.

## Install

[Download the latest release](https://github.com/kuy124/netacad-companion/releases/latest).

| Browser | File |
| --- | --- |
| Chrome, Edge, Brave, Vivaldi | `netacad-companion-v0.1.1-chromium.zip` |
| Firefox 128+ | `netacad-companion-v0.1.1-firefox.xpi` |

For Chromium browsers, extract the ZIP, open `chrome://extensions`, enable Developer
mode and choose **Load unpacked**. Select the folder containing `manifest.json`.

For Firefox, open `about:debugging#/runtime/this-firefox`, choose
**Load Temporary Add-on** and select the XPI. The unsigned add-on unloads when Firefox closes.
Permanent installation requires Mozilla signing.

Follow your organization's browser policies. These are not browser-store packages.

## Use

Open the **NetAcad Companion** panel at the bottom right of your course.

- **Easy** is the default. Highlights available answers; **Select answers** selects
  them. Review and submit yourself.
- **Brutal** selects and submits supported answers automatically. Switching to this
  mode can submit the current question immediately.

Shortcuts: `Ctrl+Shift+Y` selects answers, `Ctrl+Shift+H` toggles highlights,
and `Ctrl+Shift+M` changes modes. `Escape` closes the panel.

### Chapter checklist

1. Keep the course outline visible and choose Easy mode.
2. Open **Chapter checklist**, select chapters and press **Start**.
3. Keep the course tab open. Use **Stop** to cancel.

The default step delay is 0.2 seconds. The checklist reads text in section order,
opens supported reveals and tabs, skips native videos, and visits documents before
returning to the course. Unconfirmed activities receive one retry and remain listed
as pending. Video transcripts are not part of the generic button-clicking pass.

Starting a checklist permits supported self-check submissions in Easy mode.
Graded exams, unsupported activities and locked content remain manual. Reading a
topic or opening a lab's instructions does not complete its graded quiz or lab.
Completion is checked against NetAcad's indicators; the extension does not fabricate records.

## Build and test

Requires Node.js 22.18+ (22.x) or 24.11+ and npm.

```sh
npm ci
npm run build
npm run build:firefox
npm run package
npm test
npm run test:browser
npm run test:documents
npm run test:packages
```

Browser tests require Playwright and Chromium; otherwise they skip with a message.
Generated packages, screenshots and local browser diagnostics are not committed.

## Attribution

Primary source: [ingui-n/netacad-solver](https://github.com/ingui-n/netacad-solver).
Upstream declares no license; this repository does not relicense its code.
See [NOTICE.md](NOTICE.md) for attribution and dependency licensing.

Course-navigation research also used [NetAIcad](https://github.com/misterzaidxpy/NetAIcad)
and [netacad-automation](https://github.com/yadavsaurabh1/netacad-automation).
The checklist targets the English, numbered course outline and readable frames;
compatibility varies by course.

[Changelog](CHANGELOG.md) | [Issues](https://github.com/kuy124/netacad-companion/issues)
