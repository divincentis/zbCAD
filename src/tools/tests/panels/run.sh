#!/bin/sh
# Headless suites for panels.html. Unlike the CAD suites next door there is nothing to
# build first: the page is edited in place, so these test the file as it stands.
#
# Pass an absolute path to test a different copy of the page.
set -e
cd "$(dirname "$0")"
status=0
for suite in test-*.mjs; do
  printf '%-22s ' "$suite"
  if output=$(node "$suite" "$@" 2>&1); then
    echo "$output" | grep -E '[0-9]+ passed'
  else
    status=1
    echo "$output" | grep -E '[0-9]+ passed' || echo 'errored'
    echo "$output" | sed -n '/FAILURES:/,$p' | sed 's/^/    /'
    echo "$output" | grep -E '[0-9]+ passed' >/dev/null || echo "$output" | tail -15 | sed 's/^/    /'
  fi
done
[ $status -eq 0 ] && echo 'all suites passed'
exit $status
