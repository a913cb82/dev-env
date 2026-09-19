---
name: web-fetch
description: Read given URLs and sites into clean text. Use when you hold the URLs.
---

# web-fetch

Read URLs and sites into clean text. Answer from that text. Do not dump raw pages.

## Tools

- To read one or more pages, use `ketch scrape`. Pass all URLs in one call. See
  `ketch scrape -h`.
- To read a whole site or section, use `ketch crawl`. See `ketch crawl -h`.
- For HTML you hold, pipe it to `ketch extract`. It only converts existing HTML.
  See `ketch extract -h`.
- To find new URLs, use the `web-search` skill.

## Traps

- A bare domain can return `/llms.txt` instead of the homepage. Check the title.
  To read the page, disable llms handling. See `-h`.
- Blank output on a JS-heavy page signals a missing renderer. Install it with
  `ketch browser install`. Do not call the page empty.
- GitHub blob pages and repo homepages give almost no text. Read the raw file URL
  for full content. To search repo code, use `ketch code`. To read a whole repo,
  use `git clone` plus grep. Do not use `ketch scrape`.

## Output

- State the point of the page. Keep names and numbers. Quote the text you use.
  Always name the URL.
- State exactly what failed. If reads keep failing, run `ketch doctor`. Report the
  result.
