/* eslint-disable react/prop-types */
import { Button, Card, CardBody, Chip } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { MdOutlineSpeed } from 'react-icons/md'

interface AutoSwitchStatusProps {
  state?: IProxyAutoSwitchState
  enabled?: boolean
  onOpenSettings: () => void
  onRunCheck: () => void
  isChecking?: boolean
}

function formatDelay(state?: IProxyAutoSwitchState): string | undefined {
  const currentProxy = state?.currentProxy
  if (!currentProxy) return undefined
  const entry = state?.lastDelays[currentProxy]
  if (!entry) return undefined
  return entry.alive ? `${entry.delay}ms` : 'Timeout'
}

function hasMultipleGroups(state?: IProxyAutoSwitchState): boolean {
  return (state?.groupStates?.length ?? 0) > 1
}

function recoveryActionKey(action: ProxyAutoSwitchRecoveryAction): string {
  return `proxies.autoSwitch.recovery.${action}`
}

const AutoSwitchStatus: React.FC<AutoSwitchStatusProps> = (props) => {
  const { state, enabled, onOpenSettings, onRunCheck, isChecking = false } = props
  const { t } = useTranslation()
  const delay = formatDelay(state)
  const running = enabled && state?.running && !state.paused
  const paused = enabled && state?.paused

  return (
    <Card className="mx-2 mt-2">
      <CardBody className="px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Chip
              size="sm"
              color={running ? 'success' : paused ? 'warning' : 'default'}
              variant="flat"
            >
              {running
                ? t('proxies.autoSwitch.running')
                : paused
                  ? t('proxies.autoSwitch.paused')
                  : t('proxies.autoSwitch.disabled')}
            </Chip>
            {hasMultipleGroups(state) ? (
              <>
                {state?.groupStates?.map((gs) => (
                  <span key={gs.group} className="max-w-64 truncate text-foreground-500">
                    [{gs.group}] {gs.currentProxy ?? '-'}
                    {gs.lastDelay ? ` (${gs.lastDelay})` : ''}
                    {gs.lastError ? ` ⚠ ${gs.lastError}` : ''}
                  </span>
                ))}
              </>
            ) : (
              <>
                {state?.currentGroup ? (
                  <span className="text-foreground-500">
                    {t('proxies.autoSwitch.group')}: {state.currentGroup}
                  </span>
                ) : null}
                {state?.currentProxy ? (
                  <span className="max-w-64 truncate text-foreground-500">
                    {t('proxies.autoSwitch.current')}: {state.currentProxy}
                  </span>
                ) : null}
                {state?.currentRegion ? (
                  <span className="text-foreground-500">
                    {t('proxies.autoSwitch.region')}: {state.currentRegion}
                  </span>
                ) : null}
                {delay ? (
                  <span className="text-foreground-500">
                    {t('proxies.autoSwitch.lastDelay')}: {delay}
                  </span>
                ) : null}
              </>
            )}
            {state?.excludedProxies?.length ? (
              <span className="text-foreground-500">
                {t('proxies.autoSwitch.excluded')}: {state.excludedProxies.length}
              </span>
            ) : null}
            {state?.lastRecoveryAction ? (
              <span className="text-foreground-500">
                {t('proxies.autoSwitch.lastRecovery')}:{' '}
                {t(recoveryActionKey(state.lastRecoveryAction))}
              </span>
            ) : null}
            {state?.lastError ? <span className="text-warning">{state.lastError}</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" className="app-nodrag" variant="light" onPress={onOpenSettings}>
              {t('proxies.autoSwitch.title')}
            </Button>
            <Button
              size="sm"
              className="app-nodrag"
              color="primary"
              variant="flat"
              isLoading={isChecking || state?.checkingActive || state?.checkingStandby}
              startContent={<MdOutlineSpeed className="text-base" />}
              onPress={onRunCheck}
            >
              {t('proxies.autoSwitch.runNow')}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

export default AutoSwitchStatus
