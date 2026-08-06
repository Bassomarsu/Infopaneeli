export type ProviderStatus = "ok" | "stale" | "failed" | "idle";

export interface ProviderSnapshot<T> {
  id: string;
  status: ProviderStatus;
  data: T | null;
  fetchedAt: string | null;
  error: { type: string; message: string } | null;
}

export interface PriceHour {
  hour: number;
  price: number | null;
  startsAt: string | null;
}

export interface PriceDay {
  date: string;
  /** Always 24 entries indexed by local hour. */
  hours: PriceHour[];
  min: number;
  max: number;
  average: number;
  knownHours: number;
}

export interface ElectricityData {
  unit: string;
  today: PriceDay | null;
  tomorrow: PriceDay | null;
  tomorrowAvailable: boolean;
  currentPrice: number | null;
  currentHour: number;
}

export interface Note {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

export interface Settings {
  visibleStudents: string[] | null;
  scheduleLayout: "single" | "split";
  rolloverTime: string;
  hideMessagePreviews: boolean;
  nightModeStart: string;
  nightModeEnd: string;
}

export interface Dashboard {
  generatedAt: string;
  timezone: string;
  place: string;
  settings: Settings;
  notes: Note[];
  localClient: boolean;
  providers: {
    electricity?: ProviderSnapshot<ElectricityData>;
    [key: string]: ProviderSnapshot<unknown> | undefined;
  };
}
