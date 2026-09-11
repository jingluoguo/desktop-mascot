# UI Quality Rules

- Before finalizing a changed interface, inspect the rendered result in both themes and at the desktop and narrow-window breakpoints. Do not judge controls from source alone.
- New pages inherit the dashboard panel's width, gutters, and alignment. Do not introduce an independent panel width or centering rule unless the surrounding views establish the same pattern.
- Choose controls by the decision being made: use a toggle for two states, a segmented control only for compact mode switches where every option must remain visible, and a select/menu for three or more mutually exclusive settings. Do not style a menu as a row of ad hoc text tabs.
- Focus feedback belongs to the interactive element. Never outline an entire field row through a parent `:has(...)` selector unless the row itself is the interactive target.
- A selected state must remain legible without becoming the dominant visual object. Prefer the existing component language; avoid introducing a new highlight treatment for one screen.
