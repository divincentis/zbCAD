#!/bin/sh
# Drive the built bundle headlessly and report. Run tools/run-checks.sh first:
# these suites test dist/cad.html, so they test whatever was last built.
#
# Pass a path to test a different bundle, e.g.:
#   sh tools/tests/run-tests.sh ../cad.html
set -e
cd "$(dirname "$0")"
status=0
for suite in test-*.mjs; do
  printf '%-26s ' "$suite"
  # Captured rather than piped so the suite's own exit code survives; a pipe
  # would report tail's success instead and a failing suite would look green.
  if output=$(node "$suite" "$@" 2>&1); then
    echo "$output" | grep -E '[0-9]+ passed'
  else
    status=1
    echo "$output" | grep -E '[0-9]+ passed' || echo 'errored'
    echo "$output" | sed -n '/FAILURES:/,$p' | sed 's/^/    /'
  fi
done
[ $status -eq 0 ] && echo 'all suites passed'
exit $status
