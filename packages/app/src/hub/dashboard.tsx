import { useLanguage } from "@/runtime/i18n/language"
import { SettingsAppearance } from "@/settings/appearance/appearance"
import { LanguageSetting } from "@/settings/general/general"
import { SettingsList } from "@/settings/list"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { Tabs } from "@opencode/ui/tabs"
import { showToast } from "@opencode/ui/toast"
import { createMemo, createSignal, For, onCleanup, onMount, Show, type ComponentProps, type JSX } from "solid-js"
import { AccountSection } from "./account"
import { errorText, hubApi, HubError, type HubCloud, type HubSession } from "./api"
import { CloudHosts, CloudInstances } from "./cloud"
import { copy } from "./copy"
import { Connectors } from "./connectors"
import { AllMachines, Machines } from "./machines"
import { HubModels } from "./models"
import { Organizations } from "./orgs"
import { Providers } from "./providers"
import { Skills } from "./skills"
import { Users } from "./users"

type Item = { value: string; label: string; icon: ComponentProps<typeof Icon>["name"] }

const DEFAULT_PAGE = "general"
const pageFromPath = () => location.pathname.split("/")[2] || DEFAULT_PAGE

export function Dashboard(props: { session: HubSession; onSignedOut: () => void }) {
  const language = useLanguage()

  /** Reports a failed request; one refused for a missing session returns to the sign-in form instead. */
  const fail = (title: string, error: unknown) => {
    if (error instanceof HubError && error.status === 401) return props.onSignedOut()
    showToast({ variant: "error", title, description: errorText(error) })
  }

  const [revision, setRevision] = createSignal(0)
  // Whether the hub holds this user's key: shared by the providers and connectors, which need it, and the account,
  // which locks it.
  const [unlocked, setUnlocked] = createSignal(props.session.unlocked)

  // The cloud view, live from the same event stream as the machines.
  const [cloud, setCloud] = createSignal<HubCloud>({ hosts: [], instances: [], admin: null })

  const signOut = () => hubApi.logout().then(props.onSignedOut, (error: unknown) => fail(copy.error.unknown, error))

  const admin = () => props.session.user.role === "admin"
  const groups = createMemo((): { label: string; items: Item[] }[] => [
    {
      label: copy.settings.preferences,
      items: [
        { value: "general", label: language.t("settings.general.section.general"), icon: "sliders" },
        { value: "appearance", label: language.t("settings.general.section.appearance"), icon: "appearance" },
      ],
    },
    {
      label: copy.settings.models,
      items: [
        { value: "providers", label: language.t("settings.providers.title"), icon: "providers" },
        { value: "models", label: language.t("settings.models.title"), icon: "models" },
      ],
    },
    {
      label: copy.settings.hub,
      items: [
        { value: "machines", label: copy.settings.machines, icon: "monitor" },
        { value: "cloud", label: copy.settings.cloud, icon: "server" },
        { value: "connectors", label: copy.settings.connectors, icon: "extensions" },
        { value: "skills", label: copy.settings.skills, icon: "flask" },
        { value: "account", label: copy.settings.account, icon: "lock" },
        ...(admin()
          ? ([
              { value: "users", label: copy.settings.users, icon: "info" },
              { value: "organizations", label: copy.settings.organizations, icon: "folder" },
            ] satisfies Item[])
          : []),
      ],
    },
  ])

  const [page, setPage] = createSignal(pageFromPath())
  const known = createMemo(() =>
    groups()
      .flatMap((group) => group.items)
      .some((item) => item.value === page()),
  )
  const current = () => (known() ? page() : DEFAULT_PAGE)
  const currentLabel = () =>
    groups()
      .flatMap((group) => group.items)
      .find((item) => item.value === current())?.label
  const go = (value: string) => {
    if (value === current()) return
    history.pushState(null, "", `/settings/${value}`)
    setPage(value)
  }
  const onPopState = () => setPage(pageFromPath())
  onMount(() => window.addEventListener("popstate", onPopState))
  onCleanup(() => window.removeEventListener("popstate", onPopState))

  // Every page stays mounted: the machines feed the cloud page, and each section keeps its own loaded state.
  const Page = (pageProps: { value: string; children: JSX.Element }) => (
    <div class="settings-panel hub-settings-page" hidden={current() !== pageProps.value}>
      {pageProps.children}
    </div>
  )

  return (
    <div class="settings-screen hub-settings">
      <Tabs orientation="vertical" variant="settings" value={current()} onChange={go} class="settings">
        <div class="settings-mobile-nav">
          <a class="settings-back" href="/">
            <Icon name="arrow-left" size="small" class="settings-back-icon" />
            <span>{copy.chat.back}</span>
          </a>
          <div class="settings-mobile-actions">
            <Menu placement="bottom-end" gutter={8}>
              <Menu.Trigger as={Button} size="normal" variant="outline" class="settings-mobile-menu-trigger">
                <span>{currentLabel()}</span>
                <Icon name="chevron-down" size="small" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content class="settings-mobile-menu" aria-label={copy.settings.menu}>
                  <Menu.RadioGroup value={current()} onChange={go}>
                    <For each={groups()}>
                      {(group, index) => (
                        <>
                          <Show when={index() > 0}>
                            <Menu.Separator />
                          </Show>
                          <For each={group.items}>
                            {(item) => (
                              <Menu.RadioItem value={item.value} closeOnSelect>
                                <Icon name={item.icon} />
                                {item.label}
                              </Menu.RadioItem>
                            )}
                          </For>
                        </>
                      )}
                    </For>
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Portal>
            </Menu>
          </div>
        </div>
        <aside class="settings-sidebar">
          <div class="settings-nav">
            <a class="settings-back" href="/">
              <Icon name="arrow-left" size="small" class="settings-back-icon" />
              <span>{copy.chat.back}</span>
            </a>
            <Tabs.List class="settings-nav-groups" data-scrollable>
              <For each={groups()}>
                {(group) => (
                  <div class="settings-nav-group">
                    <div class="settings-nav-group-header" data-component="settings-nav-group-header">
                      <span>{group.label}</span>
                    </div>
                    <For each={group.items}>
                      {(item) => (
                        <Tabs.Trigger value={item.value}>
                          <Icon name={item.icon} />
                          {item.label}
                        </Tabs.Trigger>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Tabs.List>
            <Button variant="ghost" size="small" class="hub-settings-signout" onClick={signOut}>
              {copy.signOut}
            </Button>
          </div>
        </aside>
        <div class="settings-content">
          <Page value="general">
            <div class="settings-tab-header">
              <h2 class="settings-tab-title">{language.t("settings.general.section.general")}</h2>
            </div>
            <div class="settings-tab-body">
              <div class="settings-section">
                <SettingsList>
                  <LanguageSetting />
                </SettingsList>
              </div>
            </div>
          </Page>
          <Page value="appearance">
            <SettingsAppearance />
          </Page>
          <Page value="providers">
            <div class="hub-content">
              <Providers fail={fail} unlocked={unlocked()} onLocked={() => setUnlocked(false)} onSignOut={signOut} />
            </div>
          </Page>
          <Page value="models">
            <HubModels fail={fail} />
          </Page>
          <Page value="machines">
            <div class="hub-content">
              <Machines
                onSignedOut={props.onSignedOut}
                fail={fail}
                onChange={() => setRevision((value) => value + 1)}
                onCloud={setCloud}
              />
              <Show when={admin()}>
                <AllMachines fail={fail} revision={revision} />
              </Show>
            </div>
          </Page>
          <Page value="cloud">
            <div class="hub-content">
              <CloudInstances cloud={cloud()} fail={fail} />
              <Show when={admin()}>
                <CloudHosts cloud={cloud()} fail={fail} />
              </Show>
            </div>
          </Page>
          <Page value="connectors">
            <div class="hub-content">
              <Connectors fail={fail} unlocked={unlocked()} onLocked={() => setUnlocked(false)} onSignOut={signOut} />
            </div>
          </Page>
          <Page value="skills">
            <div class="hub-content">
              <Skills fail={fail} />
            </div>
          </Page>
          <Page value="account">
            <div class="hub-content">
              <AccountSection
                session={props.session}
                fail={fail}
                unlocked={unlocked()}
                onLocked={() => setUnlocked(false)}
              />
            </div>
          </Page>
          <Show when={admin()}>
            <Page value="users">
              <div class="hub-content">
                <Users fail={fail} />
              </div>
            </Page>
            <Page value="organizations">
              <div class="hub-content">
                <Organizations fail={fail} />
              </div>
            </Page>
          </Show>
        </div>
      </Tabs>
    </div>
  )
}

export type Fail = (title: string, error: unknown) => void
