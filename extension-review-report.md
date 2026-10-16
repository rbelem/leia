# Chrome Web Store Review Report

**Extension**: Leia: Read Aloud
**Version**: 0.1.2
**Scanned**: 2026-10-16
**Verdict**: LIKELY APPROVED

Context: resubmission after a Yellow Argon (keyword spam) strike on the
detailed description. The flagged brand list has been removed from
`store/copy/long-description.md` (verified: zero brand matches in
`store/copy/`). Follow-up pass 2026-10-16 closed all three issues below;
`store-check` (now with a spam guard) passes. What remains is dashboard
work + appeal, not code.

## Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | 0     |
| HIGH     | 2     |
| MEDIUM   | 1     |
| PASS     | 12    |

---

## Issues Found

### Unhosted privacy policy blocks submission

| Field          | Detail                                                              |
| -------------- | ------------------------------------------------------------------- |
| **Severity**   | HIGH                                                                |
| **Code**       | Purple Lithium (missing privacy policy)                             |
| **Root Cause** | The extension handles website content (reads page text; optional provider exfiltration), so CWS requires a public policy URL, but `copy.json` homepage/support/policy URLs are still null and the policy is not hosted |
| **File(s)**    | `store/copy/copy.json:41-44`, `store/privacy-policy.md`, `store/copy/chrome.md:36` |

**What's wrong:**
`store-check.mjs` passes without a hosted policy URL, but the CWS Privacy
tab will not validate until one is pasted.

**How to fix (done 2026-10-16):**

1. Done: repo is PUBLIC, so `copy.json` now carries real URLs — homepage
   `https://github.com/rbelem/leia`, support
   `https://github.com/rbelem/leia/issues`, policy
   `https://github.com/rbelem/leia/blob/main/store/privacy-policy.md`;
   runbooks (`chrome.md`, `firefox.md`, `edge.md`) updated to match.
2. Fill `copy.json` URL fields and every dashboard's policy URL.
3. Keep policy version stamp in sync with manifest (now 0.1.2).

---

### Privacy-tab guidance was conditional

| Field          | Detail                                                              |
| -------------- | ------------------------------------------------------------------- |
| **Severity**   | HIGH                                                                |
| **Code**       | Purple Nickel (data disclosure)                                     |
| **Root Cause** | The runbook said to check "Website content" only "if the wording requires it", inviting an uploader to skip a mandatory disclosure |
| **File(s)**    | `store/copy/chrome.md:35`                                           |

**What's wrong:**
Reading page text plus optional provider upload plainly IS website-content
handling. Conditional wording risks a second strike.

**How to fix:**

1. Done (2026-10-16): wording is now unconditional with the provider reason stated.
2. At submit time, check "Website content" on the CWS Privacy tab.

---

### No automated keyword-spam gate

| Field          | Detail                                                              |
| -------------- | ------------------------------------------------------------------- |
| **Severity**   | MEDIUM                                                              |
| **Code**       | Yellow Argon (keyword stuffing)                                     |
| **Root Cause** | `store-check.mjs` gates lengths, manifest/copy agreement, and asset dimensions only — a re-introduced brand list or superlative would pass CI |
| **File(s)**    | `scripts/store-check.mjs:25-58`                                     |

**What's wrong:**
The exact failure mode that caused this strike can recur silently.

**How to fix (done 2026-10-16):**

1. Done: `store-check.mjs` gained a spam-guard section failing on the nine
   strike brands plus SEO superlatives across all of `store/copy/`.
   Verified: gate passes on the current tree and catches all nine brands.
2. Re-run `node scripts/store-check.mjs` before every submission (unchanged).

---

## Passed Checks

- [x] No remote code execution (Blue Argon) — 0 `eval`, 0 `new Function`, no external script tags, no `import(http)`
- [x] No code obfuscation (Red Titanium) — `atob` hits are legitimate base64 audio decode (`engine-elevenlabs.ts:400`, `engine-mistral.ts:223`, `engine-gemini.ts:231`, `engine-local.ts:341-343`)
- [x] No cryptocurrency mining (Grey Silicon)
- [x] No copyright circumvention (Blue Zinc)
- [x] Permissions match usage (Purple Potassium) — activeTab/storage/offscreen/alarms/scripting/declarativeNetRequest + loopback hosts + optional provider hosts, all justified in `chrome.md:41-69`; no tabs/history/bookmarks/cookies/webRequest/downloads
- [x] Single purpose (Red Magnesium) — read aloud + follow-along highlight only
- [x] Description matches functionality (Red Nickel) — capability-qualified highlight claim, no superlatives
- [x] No insecure user-data transmission (Purple Copper) — only loopback `ws://`/`http://` in dev harness (`harness.ts:45`)
- [x] Keyword stuffing fixed (Yellow Argon) — 0 brand matches in `store/copy/`
- [x] Real functionality (Yellow Potassium) — full TTS engine seam, not a redirect
- [x] No undisclosed affiliates (Grey Titanium)
- [x] No history/tab tracking without consent (Purple Nickel) — no `chrome.history`/`webNavigation`/`tabs.onUpdated` URL tracking

## Next Steps (dashboard-side; no code left)

1. Paste the corrected detailed description into the CWS Store listing tab.
2. Fill Privacy tab: check "Website content", paste the policy URL from copy.json.
3. If the rejected upload was 0.1.2, cut a new tag (`v0.1.3`) — version is stamped from the tag by CI, never bump the manifest by hand.
4. Appeal via the CWS one-stop support form, citing the brand-list removal.

---

_Generated by extension-review skill. Reference: https://developer.chrome.com/docs/webstore/troubleshooting_
