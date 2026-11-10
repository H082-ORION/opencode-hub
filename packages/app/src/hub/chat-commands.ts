import { createResource, onCleanup } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { showToast } from "@opencode/ui/toast"
import { extractPromptFromMessage } from "@/composer/prompt"
import { promptLength } from "@/composer/prompt-parts"
import { useLanguage } from "@/runtime/i18n/language"
import { downloadSessionExport, fetchSessionExport, sessionExportFilename } from "@/session/commands/export"
import { selectSessionUserMessages } from "@/session/session-domain"
import { hubApi } from "./api"
import type { ChatState } from "./chat-context"

/** What a client command can ask of the composer that runs it. */
export type HubComposerActions = { openModel: () => void }

/** A slash command the hub runs itself, without a machine. */
export type HubClientCommand = {
  name: string
  description: string
  run: (composer: HubComposerActions) => void
}

/** A skill offered as `/name` and `@name`. */
export type HubSkillOption = { name: string; description: string }

/** The hub's own slash commands and the user's skills, for the composer. */
export function createChatCommands(chat: ChatState) {
  const language = useLanguage()

  // Only the skills that reach the machines: an organization's skill of the same name hides the user's.
  const [skills, { refetch }] = createResource(() =>
    hubApi.skills().then(
      (all) =>
        [...all.own, ...all.inherited]
          .filter((skill) => skill.hiddenBy === null)
          .map((skill) => ({ name: skill.name, description: skill.description })),
      () => [],
    ),
  )
  // Skills change in Settings or through the hub's own tools; read them again when either may have happened.
  makeEventListener(window, "focus", () => void refetch())
  onCleanup(chat.emitter.on("session.execution.succeeded", () => void refetch()))

  const undoTarget = () => {
    const id = chat.active()
    if (!id) return undefined
    const boundary = chat.current()?.revert?.messageID
    return selectSessionUserMessages(chat.messages())
      .filter((message) => !boundary || message.id < boundary)
      .at(-1)
  }

  // Staging fails while the model works, so it stops first. Files stay as they are: the hub only rewinds the chat.
  const undo = async () => {
    const id = chat.active()
    const message = undoTarget()
    if (!id || !message) return
    if (chat.busy()) await chat.api.session.interrupt({ sessionID: id })
    await chat.api.session.revert.stage({ sessionID: id, messageID: message.id, files: false })
    const [, setComposer] = chat.composer
    const prompt = extractPromptFromMessage(message, { attachmentName: language.t("common.attachment") })
    setComposer({ prompt, cursor: promptLength(prompt) })
  }

  const exportSession = async (id: string) => {
    const data = await fetchSessionExport({ sessionID: id, api: chat.api })
    const filename = sessionExportFilename(data.info)
    downloadSessionExport(filename, data)
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("toast.session.export.success.title"),
      description: language.t("toast.session.export.success.description", { filename }),
    })
  }

  const clientCommands = (): HubClientCommand[] => {
    const id = chat.active()
    const command = (name: string, description: string, run: (composer: HubComposerActions) => unknown) => ({
      name,
      description,
      run: (composer: HubComposerActions) =>
        void Promise.try(() => run(composer)).catch((error: unknown) => chat.fail(error)),
    })
    return [
      command("new", language.t("command.session.new"), () => chat.open(undefined)),
      command("model", language.t("command.model.choose.description"), (composer) => composer.openModel()),
      ...(id
        ? [
            ...(undoTarget() ? [command("undo", language.t("command.session.undo.description"), undo)] : []),
            ...(chat.current()?.revert
              ? [
                  command("redo", language.t("command.session.redo.description"), () =>
                    chat.api.session.revert.clear({ sessionID: id }),
                  ),
                ]
              : []),
            command("compact", language.t("command.session.compact.description"), () =>
              chat.api.session.compact({ sessionID: id }),
            ),
            command("export", language.t("command.session.export.description"), () => exportSession(id)),
          ]
        : []),
    ]
  }

  return {
    clientCommands,
    // Read without suspending: the composer sits under the screen's Suspense boundary.
    skills: (): HubSkillOption[] =>
      skills.state === "ready" || skills.state === "refreshing" ? (skills.latest ?? []) : [],
  }
}
