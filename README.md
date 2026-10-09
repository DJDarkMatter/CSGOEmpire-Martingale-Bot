# CSGOEmpire Roulette Bot — version 2.8.2

## Install

1. Extract the ZIP to a folder.
2. Open `chrome://extensions` (or `edge://extensions`). Enable **Developer mode**.
3. Click **Load unpacked** and select the extracted `roulette-bot-fixed` folder containing `manifest.json`.
4. Disable/remove the old version to avoid two bots. Refresh your roulette tab.
5. The **Roulette Bot** bar appears automatically at the top of CSGOEmpire. Its mode, **Base bet**, **Bet after streak**, stop loss, Start/Stop, and session counters remain visible.

Requires Chrome/Edge 111 or later. After updating, reload the extension card and refresh roulette so the new stake checker is loaded.

## Persistent top bar

The bar stays at the top while scrolling and does not need the browser toolbar icon. It reserves its measured height above the page and offsets the captured `#empire-header` balance header when that header is fixed or sticky. Space adjusts when the window changes size or **Page setup** expands.

**Save & Start** begins a session only when clicked. Opening the page or expanding setup never starts or restarts betting. The mode saved in the extension is preserved; simulation remains the default. **Stop** stays usable while another control awaits a response.

**Start during a spin is supported.** When roulette is recognized but betting is closed, Start arms the session and shows that it is waiting for the current roll to finish. It places no bet during that spin. On the first readable betting window, it scans the latest completed history and follows the configured countdown timing. That first history is a starting baseline, not a series of past bot wins/losses. Stop cancels the armed startup. A page that is genuinely disconnected/loading or has invalid selectors still cannot be started.

Expand **Page setup** for selectors, **Check page**, and **Save without starting**. All controls use the same saved settings and session as the existing browser popup. Round updates refresh the counters without overwriting unsaved field edits. A bar on another tab cannot stop or reset the session owned by your roulette tab.

The top status shows waiting, betting, stopped, or errors. The redundant lower startup/status row has been removed. Money fields accept either `0.01` or `0,01`; commas convert to dots and amounts display with two decimal places. The minimum base bet is `0.01`. **Bet after streak** accepts whole numbers starting at **1**.

**Net profit** shows gains as positive and losses as negative, based on settled session bets. **Next bet** shows the next stake. **Runtime**, immediately to the right of **Without T · CT**, shows elapsed time as `HH:MM:SS`. It starts with each new session, updates between rounds, freezes when the bot stops or pauses, and returns to zero after Reset. The saved start/stop times survive a service-worker restart. Sessions started before version 2.6 have no recorded start time and display zero until a new session is started.

The status begins with **Betting** from the first base-bet reservation throughout the active losing progression. It keeps the detailed message, for example **Betting — Waiting for the T bet result (0.02 coins)**. Dice losses and waits to place doubled stakes keep **Betting** visible. A win ends that progression; the status returns to waiting unless another bet is already being prepared. Stop and error messages remain visible when the bot is inactive.

## Placement timing

Version 2.7.2 changes amount preparation after checking the public site scripts referenced by the supplied HTML. The site has a separate `roulette.betAmountRaw` store; its Bet button reads that store, while its currency-input blur handler commits the input model. A correct-looking field alone therefore does not prove the amount has reached the betting handler.

The adapter now waits for the cleared model to propagate, writes a plain decimal amount, allows the new model to settle **before** blur, and explicitly notifies the blur handler even when native focus/blur has no effect. A small read-only page script then checks the site's stored stake against the requested stake, both before submission and again immediately before the single Bet click. It never writes to the site's store or calls its betting API. Simulation does not use this checker. Choose the site's coin currency; a fiat conversion that changes the stake causes a mismatch and prevents the click.

If the field displays `0.01` while the store remains zero or holds another amount, the bot now reports both values and sends no Bet click. An unavailable checker also prevents live clicks. These checks address the input/model mismatch and provide precise diagnostics; live server acceptance remains unverified. The captured site's handlers were inspected, but the exact cause on your currently running page has not been observed directly.

The bot reads each completed result and settles an accepted previous bet as usual, then waits until approximately **10 seconds remain** on the betting countdown before reserving and placing the next stake. This applies to the first qualifying bet and to every doubled bet after a loss. It continues tracking rounds while waiting and does not create an outstanding bet merely because a stake is scheduled. After a loss, that doubled stake must be placed in the **immediately following betting window**; closure without that bet aborts the session.

**Page setup** contains **Bet with seconds left** (default `10`) and **Timing variation ± seconds** (default `0.5`). One target is chosen per betting round, so default targets fall between `9.5` and `10.5` seconds remaining. Set variation to `0` for fixed timing. Variation is a scheduling option; the reported error does not establish that the site blocked the bot.

Controls must be enabled before placement. If the selected timing window has already begun when Start is pressed, the bot can place the bet once the result is stable and controls are ready. Fewer than 5 seconds remaining prevents an unsafe click. A first bet can wait for another round; after a loss, closure of that required next window aborts. Neither case fabricates a bet or loss. Stop cancels a waiting decision immediately. Simulation follows the same timing without filling an input or clicking a betting button.

The top status distinguishes waiting to place a bet from waiting for an accepted bet's result. Live input and balance checks are deferred until placement. The adapter also records a spin that starts while a live acceptance check is still running; that check no longer blocks spin evidence needed to settle the first stake and advance to the doubled stake. An earlier amount-entry or acceptance error stays visible instead of being replaced with the old combined outstanding-bet error.

To update: stop the bot, let any accepted live bet settle, replace the extracted extension files, click **Reload** on its card in `chrome://extensions`, then refresh the roulette page. Updating the extension pauses its session. Resolve any outstanding entry before resetting and starting again. Refreshes of the roulette page during a session started with this release use the recovery described below.

## Loading, reloads, and hidden tabs

Start requires recognized roulette controls; a valid spin is allowed. If those previously recognized controls or the wheel disappear during an active session, the status changes to **Loading**, retains the chosen coin, stake, accepted bet, counters, profit, and runtime, and temporarily suspends new betting clicks. Invalid CSS and selectors matching multiple controls remain setup errors.

Version 2.8.0 also reads the site's actual roulette connection and round state. A disconnected/uninitialized roulette state triggers recovery even if all its old controls and wheel container remain visible. A separate watchdog checks controls every 250 ms and listens for the site's phase/disconnect updates; it continues while amount entry or bet confirmation is waiting, including after a spin has already been recorded. Detection blocks further clicks locally and uses one worker message to persist the session and request reload. It does not wait for a strategy task to finish or for the 15-second failure timeout.

The countdown watchdog distinguishes a real spin from a stuck clock:

- A visible zero while the site internally remains in its betting-open state reloads after **1.5 seconds**. It is not treated as proof that a spin occurred.
- A missing countdown while betting is internally open reloads after **0.5 seconds**, allowing a brief render transition.
- Normal `spin`, `roll`, and `end` states can legitimately show zero or hide the countdown. If they never finish, reload is requested after **10 seconds**, or a longer animation duration announced by the site plus two seconds.
- When the site's phase cannot be read, a visible zero uses an **8-second** fallback to avoid immediately reloading a normal spin.

An armed session that reloads before its first betting window also retains its identity and runtime, and seeds its baseline from the history available after loading. As with existing recovery, actual page loading and browser scheduling may take time; the watchdog requests recovery promptly but cannot guarantee that every round or winning opportunity will be observed.

On the **first detection** of missing roulette controls or a disappeared/hidden wheel, the bot saves the current state and immediately requests a reload of its own roulette tab. There is no two-second grace period and no wait for buffering to clear itself. This also applies during amount preparation and bet confirmation. The returning page takes over that same session and checks the saved history before any new bet. It does not activate a different tab or start a new session. There is one automatic reload per interruption.

Version 2.8.1 changes the post-reload failure check. After **15 seconds of continuous failure**, it reads the current controls, history, connection, and countdown again. A second failed fresh read at least **750 ms** later is required before an outstanding accepted/submitted bet is paused for review. A healthy read cancels that decision, and a readable normal spin resets the failure clock while recovery waits for betting to reopen. A delayed failure message cannot stop a recovered session or a later interruption. These are checks after the prompt reload, not a delay before requesting it.

**With no bet outstanding, that timeout keeps the bot active and waiting for recovery.** It preserves any doubled progression until readable controls/history can be reconciled. Version 2.8.2 applies the required-window rule: recovery may continue only while the immediately following betting window is open. Proof that it closed without the doubled bet aborts, regardless of the unbet round's eventual result. If there is no losing progression and the old history cannot be matched, the bot scans a fresh visible baseline and resumes without changing settled wins, losses, profit, or runtime. An interrupted first stake that was never clicked is released and does not create a losing progression or a missed-window stop. Unreadable history keeps that no-bet session waiting; Stop still cancels its automatic resumption.

Before any new stake, the bot compares the saved chronological history with the returning history:

- If the original betting window is still open, an accepted outstanding bet remains outstanding; it is not clicked again.
- A confirmed accepted bet that lost, including Dice, is settled once and doubles the next stake on the same coin. A confirmed accepted win settles once and resets the stake to the base bet.
- A loss with its immediately following betting window still open continues normally at the doubled stake. A loss by itself never stops the session.
- If that next window closed without the required doubled bet, the bot aborts immediately when closure can be established. If returning history shows a completed extra unbet round after the accepted loss, it also aborts. The skipped round need not be a win; Dice and other losing results have the same abort rule. Unbet rounds create no extra accounting loss, win, or doubling.
- If buffering interrupts a money click before its acceptance can be confirmed, the bot still reloads immediately, retains that submitted stake, and stops for review. Ambiguous outstanding outcomes or a history window that no longer overlaps the saved one during an outstanding bet or losing progression also prevent further bets. An unmatched window without either can use a fresh baseline. The bot never retries an uncertain money click.

Repeated identical icons can make the exact number of missed rounds unknowable. Recovery continues only when all matching histories agree about the accepted bet outcome and show no possible missed required doubled-bet window. If only the absence count is uncertain outside an ongoing losing progression, **Without T / CT** shows `≥` and the smallest count supported by those histories; a subsequent matching coin resets its counter to an exact zero. Profit and doubling still use accepted bets only. A site state that explicitly reports betting open takes priority over temporarily disabled controls or a zero countdown when deciding whether a betting window really closed.

Switching tabs does not intentionally stop the bot. The adapter can read connected controls in a hidden tab even when Chrome supplies no layout rectangles, and it checks round state when visibility changes. Observed mutations and timer updates continue normal tracking. If the site removes its game while hidden, the same loading/reload recovery applies. Chrome can throttle timers or discard background tabs, so exact background bet timing cannot be guaranteed; resumption still checks for missed required windows and uncertain results. See Chrome's [timer throttling documentation](https://developer.chrome.com/blog/timer-throttling-in-chrome-88).

**Stop** cancels automatic recovery/reloads and new bets. An already accepted bet can still be settled if its result can be established. Reset remains available only when stopped.

## Page controls from your HTML

The defaults now match the rendered page HTML you supplied. Manual picking is not required for that layout. These identifiers were present in the actual capture:

| Control | Selector |
| --- | --- |
| Amount input | `[data-testid="roulette-bet-input"] input[inputmode="decimal"]` |
| T button | `#bet-button-t` |
| CT button | `#bet-button-ct` |
| History icons | `[data-testid="previous-rolls-item"] > div` |
| Countdown | `[data-testid="countdown-time"]` |
| Balance | `[data-testid="balance"] [data-testid="currency-amount"]` |

The history identifies results using `coin-t`, `coin-ct`, and `coin-bonus`. Bonus is accounted as Dice. The bot compares the history before and after a completed round and detects whether a new result was appended or prepended, including while stopped. Start uses the learned direction, or the preceding session's direction for the same history selector. On a fresh page before any history change, it uses the end selected by **Latest / newest history result**; the default selects the last icon. If your page puts the newest result first, select the first icon or let one result update before starting. Skipped updates enter history reconciliation; unresolved outcomes pause the session.

The captured “Rolling” element contains a positive betting countdown. It is not used as a spinning indicator merely because it exists. The adapter detects closure when the countdown disappears/ends or both buttons disable. It supports the site's custom `disable="true"` attribute as well as native disabled buttons.

Open **Page setup → Check page** while betting is open. It checks that the configured controls and result classes can be read. Simulation is the default; use it to verify that actual rounds are counted once. Select **Live betting** and **Save & Start** to enable button clicks.

Your capture did not include own-bet amount displays. Live mode therefore uses the captured balance display: after one click, an exact deduction equal to the stake must remain stable on a second reading before acceptance is recorded. A missing deduction or a larger unexpected change pauses the bot without fabricating a loss. Do not make manual bets, deposits, withdrawals, or run another betting bot while this session is active; those balance changes would make acceptance ambiguous. An insufficient displayed balance prevents the click.

Live amount entry clicks/focuses the field before editing and lets that interaction settle. It clears the previous value, inserts the exact two-decimal stake through the native setter with `beforeinput`, `input`, and `change` events, then blurs it. It allows **750 ms** for widget processing, runs the field's formatting click again, moves focus to the betting button, and checks the amount again after a further **250 ms**. The field need not remain focused. A replaced input cancels preparation before any money click and enters recovery. Strict decimal and round checks run again immediately before the sole betting click, after the durable submission acknowledgement.

The earlier packaged version waited only 300 ms after setting the field and did not click it to run its formatting handler. A stale widget model or delayed formatting is a plausible explanation for a displayed `0.01` being rejected until a manual field click, but the supplied HTML does not reveal the actual handler. The extension writes plain ASCII digits and a dot, rejects residual invisible characters, and logs the exact field characters if entry or acceptance fails. An unconfirmed click writes a `[Roulette Bot] Unconfirmed bet amount` diagnostic in the page console with the requested stake and Unicode code points; it does not log account details or balances. These diagnostics distinguish a character problem from plain `0.01` reaching a still-unsynchronized or rejected widget. The cause and live acceptance remain unverified.

With controls present, acceptance has the existing 4.5-second confirmation deadline. If controls or the confirmation display disappear during that check, it immediately reloads for review instead of waiting out the deadline. The submitted stake remains recorded and is not retried.

Both own-bet selector fields can remain blank. If the site exposes separate accepted T/CT amounts, you may fill both fields to use that method instead. A lone own-bet field is rejected. Only visible balance displays are read, so the duplicate desktop/mobile markup does not cause double accounting.

Previous candidate defaults are migrated automatically; custom selectors are preserved. If updating an installed copy, replace the extension files, click **Reload** on the extension card, and refresh the roulette tab. Start a new session after resolving any pending session entry.

If the site changes its layout, use **Pick** or edit the selectors. The picker intercepts its selection click and does not place a bet. Escape cancels it. **Save settings without starting** saves setup changes. No API key or login credentials are required.

## Strategy and accounting

- **Bet after streak** means that many consecutive results without T or without CT. Each coin has its own persisted counter. Start scans the visible completed results in chronological order to initialize both counters, then refreshes that baseline before its first decision. For example, two recent CT results initialize the without-T counter to 2. These historical results do not create past bot wins, losses, or stakes.
- T resets only the without-T counter; CT resets only the without-CT counter. Dice increases both counters and never resets either. For example, T → Dice → T is three rounds without CT.
- When a counter reaches **Bet after streak**, bet on that missing coin. With a value of 1, a single CT result qualifies T and a single T result qualifies CT. If both qualify, choose the coin absent longer; equal counts choose T. Initial history is limited to the results actually available on the page; the bot cannot infer an unseen earlier streak. Counters can exceed the ten visible results while the session keeps observing rounds.
- Once a bet is accepted, keep the chosen side and double the next stake after **every loss**, including Dice. A qualifying counter for the other coin never switches an ongoing losing progression.
- Only a win successfully ends that progression and resets the stake to the base amount. A missed required doubled-bet window aborts without resetting the stake or pretending it won. The winning coin also resets its missing counter. If the other coin already qualifies after a win, a new progression may start on that coin at the base amount.
- Example with a 10-coin base: bet 10 → Dice loss → bet 20 on the same coin → another Dice loss → bet 40 on the same coin → win → reset the stake to 10.
- A T/CT win is accounted as net profit equal to the stake (2× total return). Loss is the stake. **Net profit** is positive when the session is in profit and negative when it is in loss.
- Stop loss is a limit on net session loss. `0` disables it. The bot stops **before** a stake that could take the loss above the limit. It does not cap a doubled stake to an unrelated amount.
- Simulation uses the same strategy and accounting but never fills the amount field or clicks a betting button.

## Runtime behavior

- Only the tab where Start was pressed can run the session.
- Every bet is durably reserved before a click. It is settled only after an accepted bet and a later closed → open round transition.
- Completed results are counted once per round, including consecutive results of the same color. If a completed-result ID is available, the bot also waits for that ID to change.
- The supplied history has no round IDs. The adapter correlates observed closed → open transitions with one new history entry, waits for stable rendering, and verifies the shift direction. Identical history windows consisting entirely of one color use the observed phase transition. The extension cannot recover unobserved rounds while the page is suspended.
- A temporarily missing element enters loading recovery. A rejected amount or uncertain acceptance pauses the bot without fabricating a loss or retrying an uncertain click.
- A temporarily disabled control inside the placement window can recover before the 5-second cutoff. Countdown timing is checked again after amount entry and immediately before clicking. A changed round or closed window prevents the click.
- Closing the popup does not stop the bot. Stop prevents future bets; an already accepted bet is still tracked until its result.
- Page reloads during a session started with this release reconcile the saved history before resuming. Recovery with no outstanding bet remains active while awaiting readable controls/history; an unresolved outstanding bet or an untraceable losing progression pauses for review. Closing the tab, updating the extension, or restarting the browser pauses the session. Outstanding bets remain recorded for review.
- A dormant/restarted MV3 service worker reads durable state and handles the next page event. There is no background timer whose memory must survive suspension.
- Reset session clears only the extension's session data, including unresolved bets. It never cancels or alters website bets. Check an unresolved bet on the page before resetting.

## Verified and unverified

Local automated checks cover round deduplication, delayed settlement, symmetric T/CT Martingale progression through repeated Dice losses, Dice-inclusive missing counters, counters beyond ten rolls and worker restarts, stop loss, stop behavior, async messages, concurrent requests, stale sessions, actual site coin classes, history order, countdown closure, custom disable attributes, hidden duplicate balances, exact deductions, and insufficient balance. Top-bar checks cover mounting without starting, measured page/header offsets, a late-loaded header, expanded setup, exact settings, stale responses, unsaved edits, Start/Stop concurrency, failed starts, picker behavior, session synchronization, and tab ownership. The packaged extension also has its manifest, script paths, JavaScript syntax, and ZIP checked.

Version 2.4 also checks one-cent point/comma validation, a controlled amount input that commits on blur, two-cent progression after a Dice loss, threshold 1, startup history seeding at either end of the list, direction learning before Start, baseline refresh, and the revised toolbar fields and status row.

Version 2.5 added cases covering the delayed `0.01 → loss → 0.02` sequence for either coin, a spin starting during live confirmation, idempotent waiting decisions, simulation timing, transient control readiness, Stop and worker restart while waiting, unplaced skipped rounds, timing variation including zero, a changed round during amount entry, and preserving the original acceptance error. These checks simulate the page and do not prove server acceptance on the live site.

Version 2.6 added display checks covering runtime updates between rounds, restored session timing, freezing on Stop, reset/new-session timing, and **Betting** remaining visible through a Dice loss and doubled stake until a win. They also verify both profit and loss signs.

Version 2.7.1 has **104 local checks** in total. Added cases cover click-activated and delayed stake models, ASCII versus invisible characters, input replacement, cancelled edits, immediate reload on control or wheel disappearance, loading during preparation or confirmation, preservation of unconfirmed submitted stakes, document handoff, worker restart, both history directions, loss/win reconciliation, skipped unbet rounds, missed chase wins, Stop during loading, reload limits/timeouts, hidden-tab layout, and missed spin observations. They use a simulated page and do not prove server acceptance or browser background scheduling on the live site. Detection and reload cannot guarantee that every round is observed or every betting window remains open.

Version 2.7.2 has **108 local checks** in total. New cases cover the site's separate currency model and blur commit, ineffective native focus on either side, one-cent entry followed by two-cent progression, a correct visible amount with a zero stored stake, a store reset during the asynchronous submitted reply, and missing/unsupported stake checks. The focus-unavailable regression also fails against the packaged 2.7.1 content script. The checks remain simulated and place no real wagers.

Version 2.8.0 has **120 local checks** in total. New cases cover live/simulation Start during a spin, both history directions, the latest startup history, Stop while armed, disconnected startup rejection, disconnection with stale controls in open/closed phases, recovery during blocked confirmation after a spin was recorded, exact zero/missing-countdown thresholds, legitimate spin transitions, longer announced animations, unavailable phase checks, armed-session document handoff, and Stop taking priority over loading/reload requests. The stale-controls loading and mid-spin startup regressions both fail against the previous 2.7.2 content script. These tests simulate the site and do not verify live server acceptance or real browser scheduling.

Version 2.8.1 has **130 local checks** in total. New cases cover long failed recovery with no bet, fresh-baseline recovery without a losing progression, temporarily unreadable history, interrupted unclicked first stakes, preservation of a doubled progression, two delayed fresh failure checks, a transient error superseded by a healthy final read, normal-spin resets of the failure clock, stale failure messages, and Stop during continued recovery. Existing loss/doubling, missed-win, uncertain-click, amount-entry, startup, and toolbar checks continue to pass. These checks simulate the site and place no real wagers.

Version 2.8.2 has **137 local checks** in total. Recovery and observed closure now enforce the immediately following doubled-bet window, even when the missed round is Dice or another loss. Added cases cover both coins, continued doubling while that window is open, accepted current spins, unbet startup, a recovered win that ends its progression, prompt closure detection during recovery, closure during stake preparation, and temporarily disabled controls/zero with the site's actual betting state still open. No-bet recovery, stake entry, rapid reloads, and normal loss progression remain covered. These are simulated checks, not live server verification.

Run the included tests with Node.js: `node tests/run.cjs` from this extension folder. No packages need to be installed.

The selector targets were checked against the supplied HTML. The sanitized test fixture includes only the roulette controls; account details and chat were removed, and its balance is synthetic. Dynamic tests simulate site updates and acceptance; toolbar tests use a simulated DOM, so they do not verify the rendered layout on the live site. The development browser still could not load live roulette, so actual countdown transitions, post-click balance updates, and server acceptance remain **unverified live**. No real bets were placed during development.
