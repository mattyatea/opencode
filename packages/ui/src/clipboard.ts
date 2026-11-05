export async function writeClipboard(text: string): Promise<boolean> {
  const written = await navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  )

  if (written) return true
  // Keep the selection inside any active focus trap, including an open menu.
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const host = active && active !== document.body ? (active.parentElement ?? document.body) : document.body
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.setAttribute("aria-hidden", "true")
  textarea.tabIndex = -1
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  host.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()
  active?.focus({ preventScroll: true })

  return copied
}
