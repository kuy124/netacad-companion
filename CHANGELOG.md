# Changelog

## [0.1.2] - Quiz-start fix and draggable panel

### Added
- Drag the panel header or compact control to move it away from course buttons.
- Move the focused header with arrow keys; Home resets its position. The panel stays on-screen after resizing.

### Fixed
- Select answers and its hotkey remain available during checklist runs, without automatic submission.
- Busy solver requests retain their checklist context instead of being dropped.
- Checklists no longer click quiz or self-check Start buttons. These activities stay pending for manual Start.
- The first question can be selected after a manual Start without submitting it first, including nested frames.
- New components no longer inherit the traversal identity of removed components.
- Standard `_isCorrect` answer data is supported alongside existing selection flags.
- Graded assessments remain manual.

## [0.1.1] - Naming and documentation

### Changed
- Renamed the project, extension UI and repository to NetAcad Companion.
- Removed emojis and shortened the documentation and release notes.
- Kept existing preferences and extension identifiers for compatibility.

## [0.1.0] - Initial release

### Added
- NetAcad-styled Easy/Brutal controls and keyboard shortcuts.
- Selectable chapter checklists with a fast, adjustable 0.2-second default pace.
- Ordered text reading, reveal/tab handling, native video skipping, and document visits.
- Pending-item reporting, bounded rechecks, Stop controls, and Chrome/Firefox packages.

### Fixed
- Duplicate overlays in course frames.
- Back-and-forth scrolling through overlapping wrappers.
- Repeated clicks when tabs/buttons rerender.
- Ignored native PDF description/instructions buttons.
- Reading summaries skipped merely because their title contains “Practice.”

### Important
- Graded quizzes/exams and unsupported activities remain manual.
- Firefox packages are unsigned temporary add-ons.
- Heavily based on and inspired by [ingui-n/netacad-solver](https://github.com/ingui-n/netacad-solver);
  original solver credit belongs to the upstream project. See [NOTICE.md](NOTICE.md).

[0.1.2]: https://github.com/kuy124/netacad-companion/releases/tag/v0.1.2
[0.1.1]: https://github.com/kuy124/netacad-companion/releases/tag/v0.1.1
[0.1.0]: https://github.com/kuy124/netacad-companion/releases/tag/v0.1.0
