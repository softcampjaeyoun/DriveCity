// localStorage 는 시크릿 창 등에서 예외를 던질 수 있어 모두 감싼다
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 저장 불가 환경 */
    }
  },
  getJSON<T>(key: string): T | null {
    const raw = this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  setJSON(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  },
};
