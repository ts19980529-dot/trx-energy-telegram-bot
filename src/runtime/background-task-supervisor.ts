export class RuntimeCapabilityGate {
  private available = true;

  isAvailable(): boolean {
    return this.available;
  }

  disable(): void {
    this.available = false;
  }
}

export function superviseBackgroundTask(
  taskName: string,
  task: Promise<void>,
  onFatal: (error: unknown) => void = () => undefined,
): Promise<void> {
  return task.catch((error: unknown) => {
    onFatal(error);

    const errorName =
      error instanceof Error ? error.name : "UnknownError";
    console.error(
      `Background task halted: task=${taskName}; name=${errorName}`,
    );
  });
}
