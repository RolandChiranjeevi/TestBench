# Suites on a schedule

A suite (the **Suites** tab under **Runs**) is a saved list of test cases that you start a run from in one click. A suite can also have a **schedule**:
when the time comes, Testbench makes a run of the suite for you, so the cases are waiting when you sit down to test.

**A scheduled run is a manual run.** It is the same run the **Run** button makes, with every case untested, for a person to go through. Nothing is
executed automatically and nothing is decided, approved or changed by the schedule. Running automated tests from a schedule is not part of this.

(The folders in the Test cases tree only organise cases. A schedule belongs to a suite, not to a folder.)

## Setting a schedule

Open a suite with **Edit** (or **New suite**). Under **When to run**:

- **Run by hand** (the default): the suite is only run when someone presses **Run**. Choosing it on a suite that has a schedule takes the schedule away.
- **On a schedule**:
  - **Repeat**: *Every day*, *Certain weekdays* (tick the days), or *Custom (cron)*.
  - **At**: the time of day.
  - **Time zone**: the browser's by default; any name from the list, such as `Europe/Stockholm`. The schedule keeps this zone, never the server's, so
    "08:00" means 08:00 there, summer time included.
  - **Custom (cron)**: a cron expression of five fields: minute, hour, day of month, month, day of week (`0 8 * * 1-5` is 08:00 on weekdays).
    Numbers, ranges, lists, steps and the names of months and days (`JAN`, `MON`) are allowed. Seconds, `@daily`-style words and the extra
    symbols `L`, `W`, `#` and `?` are not. A schedule that is saved as a daily or weekly time opens as that again; anything else opens as Custom,
    exactly as it was written.

**Preview.** As soon as the schedule is complete, the form lists the next five times, in the chosen zone, worked out by the server. If the
schedule is not allowed, the server's own message is shown instead (for example *This schedule runs more often than every 15 minutes (two runs are
5 minutes apart)*) and **Save** stays off until it is fixed. The preview saves nothing.

**Start a run when I save.** Tick it to also start a run right away. This is two separate steps, and the form says so:
1. The suite and its schedule are saved.
2. A manual run of the suite is started (a normal run, not marked as scheduled), and you are taken to it.

If step 2 fails, the error is shown and step 1 still stands: the suite and its schedule are saved.

Saving the same schedule again changes nothing; the next time is not pushed back. Changing the time zone or the expression works out a new next time.

## On the Suites tab

- A **schedule chip** on the suite: *Weekdays 08:00 (Europe/Stockholm)*, or the cron expression itself for a Custom schedule. A long one is cut off
  with "…" on a narrow screen.
- **next Mon 08:00**: when it runs next. Within a day it says *in 25 min* or *in 3 h*. *no next run* means the schedule has no time left.
- **Schedule log**: opens the latest ten times the schedule fell due and what became of each (see below), with a link to the run.
- On **Runs**, a run made by a schedule has a **Scheduled** chip, in the list and on the run's page, next to **Suite: …**. It is named
  *Suite name · date (scheduled)*, with the date in the suite's own time zone.

## The schedule log

Every time that falls due is written down once, whatever came of it:

| Outcome | Shown as | Meaning |
| --- | --- | --- |
| `started` | Run prepared | The run was made. A note says if it was late ("Started 3 minutes late"). |
| `skipped_overlap` | Skipped: the last scheduled run is still open | The previous scheduled run of this suite is still in progress, so no new one is made. |
| `skipped_empty` | Skipped: no test cases | The suite has no cases (for example they were deleted). |
| `missed` | Missed: more than 2 hours late | It was too late to run (see the rules). |
| `error` | Error | Something went wrong; the note says what. Nothing half-made is left, and the time is not tried again. |

## The rules

- **At least 15 minutes between runs.** A schedule that runs more often is refused, however it is written. At most **50 scheduled suites** per project.
- **Late, but not too late.** If a time is up to **2 hours** late (the computer was asleep, the app was being restarted), the run is made once. More than
  2 hours late, nothing is made and the time is logged as `missed`. Several missed times in a row count as one: the next time is worked out from now,
  so there is never a pile of runs when the app starts again.
- **No overlap.** If the previous *scheduled* run of the suite is still in progress, the new one is skipped. A run somebody started by hand does
  not count, and does not block the schedule.
- **The cases are the ones the suite holds at that moment**, not the ones it held when the schedule was made.
- **Summer time.** A time that does not exist (02:30 on the day the clocks go forward) runs at 03:00 local time; a time that happens twice (02:30
  when they go back) runs the first time. Either way the day gets one run.
- **Once only.** Each time is claimed in the database before anything is made, so two ticks, or two Testbench processes on the same data, cannot
  start the same run twice.

## Running it

- **Testbench has to be running.** The timer looks for due suites 15 seconds after the app starts and then every minute, so a run starts within about
  a minute of its time. A time that passes while the app is off is handled when it starts again, by the late/missed rule above.
- **`TESTBENCH_SCHEDULER=0`** turns the timer off. Schedules are still saved and shown, but nothing is started from them, and the form and the
  log say so. Use it for a second instance on the same data (for example a Docker container next to a local copy), so that only one of them makes the runs.
- The scheduler never starts automated tests, runs commands, or contacts anything outside Testbench.

## Who can do what

| Role | Schedule |
| --- | --- |
| **Viewer** | Viewers can see the schedule chip, next run time, and schedule log; they cannot open the schedule editor or preview. |
| **Tester** and above | Sets, changes and removes a schedule, as for any other change to the suite. |
