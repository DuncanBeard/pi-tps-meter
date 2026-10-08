# pi-tps-meter

A tokens-per-second meter for [pi](https://pi.dev). While the model streams, it draws a live braille line graph of output tok/s above the editor, with response averages beside it.

```text
 100 ┤⠀⠀⠀⠀⣀⢄⢄⡠⢄⢄⠤⣀⠤⣀⠤⣀⢄⣀⠀⠀⠀⠀⣀⡀⡀⠀⣀⡀⡀⢀⢀⡀⣀⣀⣀⡀  71.4 tok/s avg (excl. 2.3s model wait)
     ┤⠀⣀⠔⠊⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⡄⠀⢀⠏⠀⠈⠈⠉⠀⠈⠈⠁⠁⠈⠀⠀⠀⠀  58.2 incl. wait · 73.0 now
   0 ┤⠊⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠑⠺⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀  ● streaming  1.8k tok · 25.8s gen
```

## Install

```bash
pi install npm:@duncanbeard/pi-tps-meter
```

Or try it for a single session without installing:

```bash
pi -e npm:@duncanbeard/pi-tps-meter
```

## What it shows

- **tok/s avg**: output tokens divided by generation time for the current response. The headline number leaves out time-to-first-token and tool execution.
- **incl. wait**: the same average with model wait (request → first token) added back in. Tool time is never counted.
- **now**: the instantaneous rate over a 1-second sliding window.
- **status**: `● waiting` for the model, `● streaming`, `◌ tools` while tools run, `○ done` when the run ends. Also shows total tokens and generation time.

## Commands

| Command | Effect |
| --- | --- |
| `/tps` | Toggle the meter |
| `/tps on` / `/tps off` | Show / hide the meter |
| `/tps clear` | Reset the graph |

## How it measures

- While text, thinking, and tool-call deltas stream in, the live rate is estimated at ~4 characters per token.
- When each assistant message finishes, the estimate is replaced by the provider-reported `usage.output`, so the averages are accurate.
- Generation time runs from the first streamed token to the end of the message. Wait time runs from the model request to the first token. Because the request time is taken after tools finish, tool execution never counts as waiting.
- The graph resets when an agent run starts and when you open a new, resumed, or forked session. `/reload` keeps it.

The meter only renders in pi's interactive UI.

## License

MIT
