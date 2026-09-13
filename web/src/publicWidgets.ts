export interface MenuData { locationId: string; locationName: string; sourceUrl: string; days: { date: string; meals: { type: string; name: string }[] }[] }
export interface NamedayData { today: { date: string; names: string[] }; tomorrow: { date: string; names: string[] }; calendarYear: number; sourceUrl: string }

export interface MenuSchool extends MenuData { status: "ok" | "stale" | "failed" | "loading"; error: string | null; fetchedAt: string | null }
export interface MenuCollection { schools: MenuSchool[] }
