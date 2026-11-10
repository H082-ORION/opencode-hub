import { onCleanup } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"
import { createNotificationCoordinator } from "@/shell/notifications/coordinator"
import { playSoundById } from "@/shell/notifications/sound"
import type { ChatState } from "./chat-context"

/**
 * Announces a top-level session that finished or failed with the chosen sound and a system notification, as the app
 * does, but only when the tab is hidden or the session isn't the open one: the open session already shows its result.
 */
export function useChatNotifications(chat: ChatState) {
  const settings = useSettings()
  const platform = usePlatform()
  const language = useLanguage()
  // Dedupes across hub tabs and skips the system notification while a hub window has focus.
  const coordinator = createNotificationCoordinator()

  const announce = async (input: { sessionID: string; eventID: string; failed: boolean }) => {
    // A running subagent's report wakes the session again, so it isn't done yet.
    if (!input.failed && hasRunningChild(chat, input.sessionID)) return
    const session =
      chat.data.session.get(input.sessionID) ??
      (await chat.data.session
        .sync(input.sessionID)
        .then(() => chat.data.session.get(input.sessionID))
        .catch(() => undefined))
    if (session?.parentID) return
    if (!input.failed && !session) return
    if (document.visibilityState === "visible" && chat.active() === input.sessionID) return

    const sound = input.failed
      ? settings.sounds.errorsEnabled() && settings.sounds.errors()
      : settings.sounds.agentEnabled() && settings.sounds.agent()
    if (sound) void coordinator.sound(input.eventID, () => playSoundById(sound))

    if (!(input.failed ? settings.notifications.errors() : settings.notifications.agent())) return
    const title = language.t(
      input.failed ? "notification.session.error.title" : "notification.session.responseReady.title",
    )
    const description =
      session?.title || (input.failed ? language.t("notification.session.error.fallbackDescription") : input.sessionID)
    void coordinator.system(input.eventID, () => platform.notify(title, description, () => chat.open(input.sessionID)))
  }

  onCleanup(
    chat.emitter.on("session.execution.succeeded", (event) =>
      announce({ sessionID: event.data.sessionID, eventID: event.id, failed: false }),
    ),
  )
  onCleanup(
    chat.emitter.on("session.execution.failed", (event) =>
      announce({ sessionID: event.data.sessionID, eventID: event.id, failed: true }),
    ),
  )
}

// Only direct children, as in the app: a grandchild reports to its own parent.
function hasRunningChild(chat: ChatState, sessionID: string) {
  return chat.data.session
    .family(sessionID)
    .some(
      (child) =>
        child !== sessionID &&
        chat.data.session.get(child)?.parentID === sessionID &&
        chat.data.session.status(child) === "running",
    )
}
