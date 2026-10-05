import { config } from '../config.ts';
import { HttpError, Semaphore, sleep } from './http.ts';

export interface IgemTeamSummary {
  id: number;
  name: string;
  villageUUID?: string | null;
  region: string;
  country: string;
  city: string;
  section: string;
  program: string;
  status: string;
  year: number;
  isRemote: boolean;
}

export interface IgemTeamDetail extends IgemTeamSummary {
  slug: string;
  lat: number | null;
  lng: number | null;
  institutions?: { name: string; nameLocal?: string; city?: string; country?: string }[];
}

const sem = new Semaphore(4);

async function getJson<T>(path: string): Promise<T> {
  const url = config.igemApi + path;
  for (let attempt = 0; ; attempt++) {
    const res = await sem.run(() => fetch(url, { signal: AbortSignal.timeout(30_000) }));
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(2 ** attempt * 2000);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, url, await res.text());
    return (await res.json()) as T;
  }
}

export async function listTeams(year: number): Promise<IgemTeamSummary[]> {
  const out: IgemTeamSummary[] = [];
  for (let page = 1; ; page++) {
    const res = await getJson<{ data: IgemTeamSummary[]; total: number }>(
      `/teams?year=${year}&pageSize=100&page=${page}`,
    );
    out.push(...res.data);
    if (res.data.length === 0 || out.length >= res.total) return out;
  }
}

export function getTeam(id: number): Promise<IgemTeamDetail> {
  return getJson<IgemTeamDetail>(`/teams/${id}`);
}

export function listVillages(): Promise<{ uuid: string; name: string }[]> {
  return getJson<{ uuid: string; name: string }[]>('/villages');
}
