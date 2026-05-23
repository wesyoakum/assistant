// Minimal shared types. The triage/classifier types that used to live here
// were removed along with the triage pipeline.

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture_url: string | null;
}
