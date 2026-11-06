export function largePaste(text: string) {
  return text.length >= 8000 || text.split("\n").length - 1 >= 120
}
