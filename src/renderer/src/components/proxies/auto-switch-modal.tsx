/* eslint-disable react/prop-types */
import {
  Button,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Switch,
  Textarea
} from '@heroui/react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { restartAutoProxySwitch } from '@renderer/utils/ipc'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface AutoSwitchModalProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  groups: IMihomoMixedGroup[]
}

const DEFAULT_REGIONS: IProxyAutoSwitchRegion[] = [
  { id: 'us', name: '美国', patterns: ['US', '美国', 'United States'], enabled: true },
  { id: 'jp', name: '日本', patterns: ['JP', '日本', 'Japan'], enabled: true },
  { id: 'sg', name: '新加坡', patterns: ['SG', '新加坡', 'Singapore'], enabled: true },
  { id: 'hk', name: '香港', patterns: ['HK', '香港', 'Hong Kong'], enabled: true }
]

const DEFAULT_CONFIG: IProxyAutoSwitchConfig = {
  enabled: false,
  targetGroup: '',
  targetGroups: [],
  loadBalanceMode: false,
  loadBalanceGroupName: '自动切换-负载均衡',
  activeIntervalSec: 15,
  standbyIntervalSec: 300,
  switchCooldownSec: 180,
  maxDelayMs: 800,
  failureThreshold: 2,
  closeConnectionsOnSwitch: true,
  delayConcurrency: 4,
  retryTimeoutOnce: true,
  excludePatterns: [],
  regions: DEFAULT_REGIONS
}

function clampNumber(value: unknown, fallback: number, min: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.max(Math.floor(value), min)
  return typeof max === 'number' ? Math.min(clamped, max) : clamped
}

function normalizePatterns(value: unknown): string[] {
  return Array.isArray(value) ? value.map((pattern) => String(pattern).trim()).filter(Boolean) : []
}

function defaultRegions(): IProxyAutoSwitchRegion[] {
  return DEFAULT_REGIONS.map((region) => ({ ...region, patterns: [...region.patterns] }))
}

function normalizeRegions(value: unknown): IProxyAutoSwitchRegion[] {
  if (!Array.isArray(value) || value.length === 0) return defaultRegions()

  const regions = value
    .filter((region): region is Partial<IProxyAutoSwitchRegion> => Boolean(region))
    .map((region) => ({
      id: String(region.id || '').trim(),
      name: String(region.name || region.id || '').trim(),
      patterns: normalizePatterns(region.patterns),
      enabled: region.enabled !== false
    }))
    .filter((region) => region.id && region.name)

  return regions.length > 0 ? regions : defaultRegions()
}

function normalizeConfig(config?: Partial<IProxyAutoSwitchConfig>): IProxyAutoSwitchConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    loadBalanceMode: config?.loadBalanceMode === true,
    loadBalanceGroupName:
      typeof config?.loadBalanceGroupName === 'string' && config.loadBalanceGroupName.trim()
        ? config.loadBalanceGroupName.trim()
        : DEFAULT_CONFIG.loadBalanceGroupName,
    activeIntervalSec: clampNumber(config?.activeIntervalSec, DEFAULT_CONFIG.activeIntervalSec, 5),
    standbyIntervalSec: clampNumber(
      config?.standbyIntervalSec,
      DEFAULT_CONFIG.standbyIntervalSec,
      30
    ),
    switchCooldownSec: clampNumber(config?.switchCooldownSec, DEFAULT_CONFIG.switchCooldownSec, 30),
    maxDelayMs: clampNumber(config?.maxDelayMs, DEFAULT_CONFIG.maxDelayMs, 1),
    failureThreshold: clampNumber(config?.failureThreshold, DEFAULT_CONFIG.failureThreshold, 1),
    closeConnectionsOnSwitch: config?.closeConnectionsOnSwitch !== false,
    delayConcurrency: clampNumber(config?.delayConcurrency, DEFAULT_CONFIG.delayConcurrency, 1, 20),
    retryTimeoutOnce: config?.retryTimeoutOnce !== false,
    excludePatterns: normalizePatterns(config?.excludePatterns),
    regions: normalizeRegions(config?.regions)
  }
}

function parsePatterns(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function compilePattern(pattern: string): RegExp | undefined {
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/')
    try {
      return new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1) || 'i')
    } catch {
      return undefined
    }
  }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

function isValidPattern(pattern: string): boolean {
  if (!pattern.startsWith('/') || pattern.lastIndexOf('/') <= 0) return true
  return Boolean(compilePattern(pattern))
}

function matchRegion(
  name: string,
  regions: IProxyAutoSwitchRegion[]
): IProxyAutoSwitchRegion | undefined {
  for (const region of regions) {
    if (!region.enabled) continue
    if (region.patterns.some((pattern) => compilePattern(pattern)?.test(name))) return region
  }
  return undefined
}

function matchPattern(value: string, patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    const regex = compilePattern(pattern)
    if (regex?.test(value)) return pattern
  }
  return undefined
}

function nextRegionId(): string {
  return `region-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const AutoSwitchModal: React.FC<AutoSwitchModalProps> = (props) => {
  const { isOpen, onOpenChange, groups } = props
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const [draft, setDraft] = useState<IProxyAutoSwitchConfig>(() =>
    normalizeConfig(appConfig?.proxyAutoSwitch)
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isOpen) setDraft(normalizeConfig(appConfig?.proxyAutoSwitch))
  }, [appConfig?.proxyAutoSwitch, isOpen])

  const effectiveTargetGroups = useMemo(() => {
    if (draft.targetGroups && draft.targetGroups.length > 0) return draft.targetGroups
    if (draft.targetGroup) return [draft.targetGroup]
    return groups[0] ? [groups[0].name] : []
  }, [draft.targetGroups, draft.targetGroup, groups])

  const selectedGroups = useMemo(
    () =>
      effectiveTargetGroups
        .map((name) => groups.find((group) => group.name === name))
        .filter(Boolean) as IMihomoMixedGroup[],
    [effectiveTargetGroups, groups]
  )

  const preview = useMemo(() => {
    const buckets = draft.regions
      .filter((region) => region.enabled)
      .map((region) => ({ id: region.id, name: region.name, proxies: [] as string[] }))
    const bucketMap = new Map(buckets.map((bucket) => [bucket.id, bucket]))
    const unknown: string[] = []
    const excluded: IProxyAutoSwitchExcludedProxy[] = []

    for (const selectedGroup of selectedGroups) {
      selectedGroup.all.forEach((proxy) => {
        const excludedBy = matchPattern(proxy.name, draft.excludePatterns)
        if (excludedBy) {
          excluded.push({ name: proxy.name, pattern: excludedBy })
          return
        }

        const region = matchRegion(proxy.name, draft.regions)
        if (!region) {
          unknown.push(proxy.name)
          return
        }
        bucketMap.get(region.id)?.proxies.push(proxy.name)
      })
    }

    return { buckets, unknown, excluded }
  }, [draft.excludePatterns, draft.regions, selectedGroups])

  const invalidPatterns = useMemo(
    () => [
      ...draft.regions.flatMap((region) =>
        region.patterns
          .filter((pattern) => !isValidPattern(pattern))
          .map((pattern) => `${region.name}: ${pattern}`)
      ),
      ...draft.excludePatterns
        .filter((pattern) => !isValidPattern(pattern))
        .map((pattern) => `${t('proxies.autoSwitch.excludePatterns')}: ${pattern}`)
    ],
    [draft.excludePatterns, draft.regions, t]
  )

  const patchDraft = (patch: Partial<IProxyAutoSwitchConfig>): void => {
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  const updateRegion = (index: number, patch: Partial<IProxyAutoSwitchRegion>): void => {
    setDraft((prev) => {
      const regions = [...prev.regions]
      regions[index] = { ...regions[index], ...patch }
      return { ...prev, regions }
    })
  }

  const moveRegion = (index: number, offset: -1 | 1): void => {
    setDraft((prev) => {
      const nextIndex = index + offset
      if (nextIndex < 0 || nextIndex >= prev.regions.length) return prev
      const regions = [...prev.regions]
      const [item] = regions.splice(index, 1)
      regions.splice(nextIndex, 0, item)
      return { ...prev, regions }
    })
  }

  const save = async (): Promise<void> => {
    if (invalidPatterns.length > 0) return
    setSaving(true)
    try {
      const targetGroups =
        draft.targetGroups && draft.targetGroups.length > 0
          ? draft.targetGroups
          : effectiveTargetGroups
      await patchAppConfig({
        proxyAutoSwitch: {
          ...draft,
          targetGroups,
          targetGroup: targetGroups[0] || ''
        }
      })
      await restartAutoProxySwitch()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="4xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex app-drag">{t('proxies.autoSwitch.title')}</ModalHeader>
        <ModalBody>
          {invalidPatterns.length > 0 ? (
            <div className="rounded-lg bg-danger-50 p-3 text-sm text-danger">
              {t('proxies.autoSwitch.invalidPatterns')}: {invalidPatterns.join(', ')}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Switch isSelected={draft.enabled} onValueChange={(enabled) => patchDraft({ enabled })}>
              {t('proxies.autoSwitch.enabled')}
            </Switch>
            <Switch
              isSelected={draft.closeConnectionsOnSwitch}
              onValueChange={(closeConnectionsOnSwitch) => patchDraft({ closeConnectionsOnSwitch })}
            >
              {t('proxies.autoSwitch.closeConnections')}
            </Switch>
            <Switch
              isSelected={draft.retryTimeoutOnce}
              onValueChange={(retryTimeoutOnce) => patchDraft({ retryTimeoutOnce })}
            >
              {t('proxies.autoSwitch.retryTimeoutOnce')}
            </Switch>
            <Switch
              isSelected={draft.loadBalanceMode ?? false}
              onValueChange={(loadBalanceMode) => patchDraft({ loadBalanceMode })}
            >
              {t('proxies.autoSwitch.loadBalanceMode')}
            </Switch>
            {draft.loadBalanceMode ? (
              <Input
                size="sm"
                label={t('proxies.autoSwitch.loadBalanceGroupName')}
                value={draft.loadBalanceGroupName ?? ''}
                onValueChange={(loadBalanceGroupName) => patchDraft({ loadBalanceGroupName })}
              />
            ) : null}
            <Select
              size="sm"
              selectionMode="multiple"
              label={t('proxies.autoSwitch.targetGroup')}
              selectedKeys={new Set(effectiveTargetGroups)}
              onSelectionChange={(keys) => {
                const selected = [...keys] as string[]
                patchDraft({ targetGroups: selected, targetGroup: selected[0] || '' })
              }}
            >
              {groups.map((group) => (
                <SelectItem key={group.name}>{group.name}</SelectItem>
              ))}
            </Select>
            <Input
              size="sm"
              type="number"
              label={t('proxies.autoSwitch.maxDelay')}
              value={String(draft.maxDelayMs)}
              onValueChange={(value) =>
                patchDraft({ maxDelayMs: Math.max(parseInt(value) || 1, 1) })
              }
            />
            <Input
              size="sm"
              type="number"
              min={1}
              max={20}
              label={t('proxies.autoSwitch.delayConcurrency')}
              value={String(draft.delayConcurrency)}
              onValueChange={(value) =>
                patchDraft({
                  delayConcurrency: Math.min(Math.max(parseInt(value) || 4, 1), 20)
                })
              }
            />
            <Input
              size="sm"
              type="number"
              label={t('proxies.autoSwitch.activeInterval')}
              value={String(draft.activeIntervalSec)}
              onValueChange={(value) =>
                patchDraft({ activeIntervalSec: Math.max(parseInt(value) || 5, 5) })
              }
            />
            <Input
              size="sm"
              type="number"
              label={t('proxies.autoSwitch.standbyInterval')}
              value={String(draft.standbyIntervalSec)}
              onValueChange={(value) =>
                patchDraft({ standbyIntervalSec: Math.max(parseInt(value) || 30, 30) })
              }
            />
            <Input
              size="sm"
              type="number"
              label={t('proxies.autoSwitch.failureThreshold')}
              value={String(draft.failureThreshold)}
              onValueChange={(value) =>
                patchDraft({ failureThreshold: Math.max(parseInt(value) || 1, 1) })
              }
            />
            <Input
              size="sm"
              type="number"
              label={t('proxies.autoSwitch.cooldown')}
              value={String(draft.switchCooldownSec)}
              onValueChange={(value) =>
                patchDraft({ switchCooldownSec: Math.max(parseInt(value) || 30, 30) })
              }
            />
          </div>

          <Textarea
            size="sm"
            minRows={2}
            label={t('proxies.autoSwitch.excludePatterns')}
            placeholder={t('proxies.autoSwitch.excludePatternsPlaceholder')}
            value={draft.excludePatterns.join('\n')}
            onValueChange={(value) => patchDraft({ excludePatterns: parsePatterns(value) })}
          />

          <Divider />

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">{t('proxies.autoSwitch.regions')}</h3>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="flat"
                onPress={() =>
                  patchDraft({ regions: DEFAULT_REGIONS.map((region) => ({ ...region })) })
                }
              >
                {t('proxies.autoSwitch.restoreDefault')}
              </Button>
              <Button
                size="sm"
                color="primary"
                variant="flat"
                onPress={() =>
                  patchDraft({
                    regions: [
                      ...draft.regions,
                      {
                        id: nextRegionId(),
                        name: t('proxies.autoSwitch.newRegion'),
                        patterns: [],
                        enabled: true
                      }
                    ]
                  })
                }
              >
                {t('proxies.autoSwitch.addRegion')}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {draft.regions.map((region, index) => (
              <div key={region.id} className="rounded-lg border border-default-200 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Switch
                    size="sm"
                    isSelected={region.enabled}
                    onValueChange={(enabled) => updateRegion(index, { enabled })}
                  />
                  <Input
                    size="sm"
                    className="min-w-32 flex-1"
                    label={t('proxies.autoSwitch.regionName')}
                    value={region.name}
                    onValueChange={(name) => updateRegion(index, { name })}
                  />
                  <Button size="sm" variant="light" onPress={() => moveRegion(index, -1)}>
                    {t('proxies.autoSwitch.moveUp')}
                  </Button>
                  <Button size="sm" variant="light" onPress={() => moveRegion(index, 1)}>
                    {t('proxies.autoSwitch.moveDown')}
                  </Button>
                  <Button
                    size="sm"
                    color="danger"
                    variant="light"
                    onPress={() =>
                      patchDraft({ regions: draft.regions.filter((item) => item.id !== region.id) })
                    }
                  >
                    {t('common.delete')}
                  </Button>
                </div>
                <Textarea
                  size="sm"
                  minRows={2}
                  label={t('proxies.autoSwitch.patterns')}
                  value={region.patterns.join('\n')}
                  onValueChange={(value) => updateRegion(index, { patterns: parsePatterns(value) })}
                />
              </div>
            ))}
          </div>

          <Divider />

          <div>
            <h3 className="mb-2 text-sm font-medium">{t('proxies.autoSwitch.regionPreview')}</h3>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {preview.buckets.map((bucket) => (
                <div key={bucket.id} className="rounded-lg bg-default-100 p-2 text-sm">
                  <div className="font-medium">
                    {bucket.name} ({bucket.proxies.length})
                  </div>
                  <div className="mt-1 max-h-20 overflow-auto text-xs text-foreground-500">
                    {bucket.proxies.join(', ') || '-'}
                  </div>
                </div>
              ))}
              <div className="rounded-lg bg-default-100 p-2 text-sm">
                <div className="font-medium">
                  {t('proxies.autoSwitch.unknown')} ({preview.unknown.length})
                </div>
                <div className="mt-1 max-h-20 overflow-auto text-xs text-foreground-500">
                  {preview.unknown.join(', ') || '-'}
                </div>
              </div>
              <div className="rounded-lg bg-default-100 p-2 text-sm">
                <div className="font-medium">
                  {t('proxies.autoSwitch.excluded')} ({preview.excluded.length})
                </div>
                <div className="mt-1 max-h-20 overflow-auto text-xs text-foreground-500">
                  {preview.excluded.map((item) => `${item.name} ← ${item.pattern}`).join(', ') ||
                    '-'}
                </div>
              </div>
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="light" onPress={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            color="primary"
            isDisabled={invalidPatterns.length > 0}
            isLoading={saving}
            onPress={save}
          >
            {t('common.save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default AutoSwitchModal
