export type MotionMap =
  Record<string, number>;

export type MotionChoice = {
  label: string;
  group: string;
  index?: number;
};

export function buildMotionChoices(
  motions: MotionMap
): MotionChoice[] {
  const result: MotionChoice[] = [];

  for (
    const [group, count]
    of Object.entries(motions)
  ) {
    result.push({
      label: `${group} 랜덤`,
      group,
    });

    for (
      let index = 0;
      index < count;
      index += 1
    ) {
      result.push({
        label:
          `${group} ${index + 1}`,
        group,
        index,
      });
    }
  }

  return result;
}
