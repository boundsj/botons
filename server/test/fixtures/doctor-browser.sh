#!/bin/sh
# Fixed dump-dom response for doctor finding tests. Real Chromium is covered by
# check:browser, browser tests, and the recovery check's real doctor process.
printf '%s\n' '<html><body><p>botons-browser-ok</p></body></html>'
