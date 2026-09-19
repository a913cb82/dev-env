---
name: web-search
description: Find answers on the live web, in library docs, and in real code. Use
  when you lack the sources.
---

# web-search

Find the sources. Shape them into an answer. Do not dump raw output.

## Tools

- For current info and comparisons, use `ketch search`. See `ketch search -h`.
- For how to use a library, use `ketch docs`. See `ketch docs -h`.
- For how others use X in real code, use `ketch code`. See `ketch code -h`.
- For full page text, give the URLs to the `web-fetch` skill.
- For a deep question, combine the tools. Do not trust one lookup alone.

## Method

- Write 2-3 queries with different words. Keep the count small.
- Prefer primary sources over aggregators. Do not repeat a host.
- Resolve the library name first. Check that the match is your library. Matching
  is fuzzy.
- Support important claims with docs or real code. Note deprecations and version
  limits.

## Output

- Answer first. Then list the sources with URLs.
- State conflicts. Do not blend them.
- Name failed sources and dropped sources. Do not ignore them.
- If backends keep failing, run `ketch doctor`. Report the result. Do not repeat
  the same call.
