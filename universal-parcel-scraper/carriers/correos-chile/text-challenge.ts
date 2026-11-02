/** Exact arithmetic and string operations; unfamiliar questions go to the optional model. */
export function solveCorreosChileText(heading: string, prompt: string): string | null {
  if (heading.length > 150 || prompt.length > 400) return null;
  const h = heading.trim().toLowerCase(), p = prompt.trim();
  const coins = /^A jar (?:starts with|contains) (\d{1,3}) coins\. You (?:take (\d{1,3}) coins? out|remove (\d{1,3}) coins? from it)\.?$/.exec(p);
  if (coins && /^(?:find the number of coins still in the jar\. use digits only|give the final coin count in the jar using digits only|work out how many coins remain in the jar\. use digits only|calculate the coins remaining in the jar\. answer with digits only|after the removal how many coins remain\. answer with digits only)$/.test(h)) {
    const before = Number(coins[1]), removed = Number(coins[2] ?? coins[3]);
    return removed <= before ? String(before - removed) : null;
  }
  const duplicate = /^(?:Replace every ([a-z]) with two copies of itself in|Duplicate every ([a-z]) in) ([a-z]{1,30})\. (?:Type just|Write only) the result\.$/.exec(p);
  if (duplicate) {
    const letter = (duplicate[1] ?? duplicate[2])!;
    return duplicate[3]!.replaceAll(letter, letter.repeat(2));
  }
  const replace = /^(?:Use the Latin ([a-z]) instead of every ([a-z])|(?:Replace every|Change each) ([a-z]) (?:with|to) the Latin ([a-z])) in ([a-z]{1,30})\. (?:Type just|Write only) the result\.$/.exec(p);
  if (replace) return replace[5]!.replaceAll((replace[2] ?? replace[3])!, (replace[1] ?? replace[4])!);
  const digits = /^(?:Delete every|Remove each|Take out each) (\d) from (\d{1,30})\. (?:Keep leading zeros and type only the remaining digits|Write the remaining digits, keeping leading zeros)\.$/.exec(p);
  if (digits) return digits[2]!.replaceAll(digits[1]!, '') || null;
  const count = /^(?:How many letters ([a-z]) does ([a-z]{1,30}) contain\?|Find the number of letters ([a-z]) in ([a-z]{1,30})\.) Answer using digits\.$/.exec(p);
  return count ? String([...(count[2] ?? count[4])!].filter(letter => letter === (count[1] ?? count[3])).length) : null;
}
