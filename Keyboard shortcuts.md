# Keyboard shortcuts & quick entry

A one-page reference for driving the Caseload Manager without reaching for the mouse.

> **⌘ vs Ctrl** — on macOS use **⌘ Command**; on Windows/Linux use **Ctrl**.
> Everything else is identical.

## Global

| Shortcut | Action |
| --- | --- |
| **⌘/Ctrl + K** | Open or close the **command palette** (works from any screen) |
| **Alt + E** | **New task** quick entry, from anywhere (ignored while a dialog is already open) |
| **Esc** | Close the front-most thing, one layer at a time: command palette → dialog → patient panel |
| **Tab** / **Shift + Tab** | Move between the fields of an open dialog; focus wraps around and stays trapped inside it |

## Command palette — ⌘/Ctrl + K

The palette is the fastest way to move around the app.

| Key | Action |
| --- | --- |
| **↑ / ↓** | Move through the results |
| **Enter** | Run the highlighted result |
| **Esc** | Close the palette |

The top result is highlighted the moment the palette opens, so **Enter** runs it immediately. Just start typing to filter.

Things you can do from the palette:

- **Jump** to Today, Tasks, Caseload, Diary or Settings
- **Filter** the task list: Overdue, Tasks due today, Quick wins
- **Long waits** — open the Caseload filtered to long-waiting patients
- **New task…** and **New patient…**
- **Open a patient** — type a name or patient ID
- **Open a task** — type part of its title
- **Create a task on the spot** — type anything and pick **Add task "…"**

## Quick-add a task (Tasks view)

In the Tasks view, type into the **"Add a task…"** box and press **Enter** (or click **Add**). The text understands simple dates and durations:

| Type this | And it sets |
| --- | --- |
| `today`, `tomorrow`, `tom` | the due date |
| `next week` | due in 7 days |
| `in 3 days`, `in 2 weeks` | a relative due date |
| `monday` … `fri` (or `next mon`) | the next matching weekday |
| `30m`, `1h`, `45 min` | the estimated duration |

Examples:

- `call Sam tomorrow 30m` → task "call Sam", due tomorrow, 30 min
- `chase GP referral in 2 days 15m`
- `write letter next friday 1h`

After adding, focus stays in the box so you can keep typing the next task.

## Dialogs (task, patient, event, import)

| Key | Action |
| --- | --- |
| **Esc** | Close the dialog without saving |
| **Tab** / **Shift + Tab** | Cycle through fields (focus stays inside the dialog) |

## Patient panel (the drawer)

Opening a patient shows their details as an editable form, so you can change any value by hand and save.

| Key | Action |
| --- | --- |
| **Enter** (in Name, Pathway, Status or Days) | Save the details |
| **Esc** | Close the panel |

Patient ID is fixed (linked tasks use it), and **Notes** has its own **Save notes** button.

## Not keyboard, but handy

- **Diary (Day view):** click an empty time slot to create a 30-minute event, or click-and-drag down a column to set a custom length. Click an existing event to edit it.
- **Today:** click the **Overdue** / **Quick wins** pills to expand the people and tasks behind the count.

## Not available yet

These are **not** bound to keys at the moment:

- Switching views directly (use **⌘/Ctrl + K** → "Go to …")
- Moving between days/weeks/months in the Diary
- Completing a task from the keyboard

Only the global shortcuts above plus the quick-add field are keyboard-driven.
