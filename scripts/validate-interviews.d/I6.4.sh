# Row I6.4, settings per deployment. Sourced by scripts/validate-interviews.sh.
# The phase's floor runs src/lib/interviews/__tests__/settings.test.ts.

row_I6.4() {
  exists $MW/lib/interviews/settings.ts "the settings list"
  for s in INTERVIEWS_MEDIA_RETENTION_DAYS INTERVIEWS_RECORD_RETENTION_YEARS INTERVIEWS_DELETION_WITHIN_DAYS; do
    needF "'$s'" $MW/lib/interviews/retention/periods.ts "the period $s is read from the environment"
  done
  needF "periods: () => retentionPeriods()" $MW/lib/interviews/retention/service.ts "the sweep reads the periods on every run"
  needF "REQUIRED_CONSENTS_SETTING" $MW/lib/interviews/settings.ts "the required consents are a setting"
  needF "requiredConsents" $MW/lib/interviews/consent/required.ts "the required consents' reader"
  if grep -rln "requiredConsents(" $MW/routes $MW/lib/interviews --include='*.ts' 2>/dev/null | grep -v __tests__ | grep -vq "settings.ts\|consent/required.ts"; then
    ok "the consents gate reads the required consents from settings"
  else fail "nothing but the settings list reads the required consents"; fi
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the required consents" src/lib/interviews/consent/__tests__/required.test.ts
    run_journey
    for s in I6.4a I6.4b I6.4c I6.4d; do journey_step "$s"; done
  fi
}

built_row I6.4 row_I6.4
