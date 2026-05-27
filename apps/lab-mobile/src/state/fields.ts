// Persisted field registration state.
// Stores field metadata (name, type, landmark positions, coordinate frame, boundary)
// as JSON in the app's document directory.

import { create } from "zustand";
import type { FieldCoordinateFrame, LandmarkPositions } from "../field/coordinateFrame";

export interface FieldRegistration {
  id: string;
  name: string;
  fieldType: string;
  createdAt: number;
  landmarks: LandmarkPositions;
  coordinateFrame: FieldCoordinateFrame | null;
  boundaryPolygon: [number, number][] | null;
}

interface FieldsState {
  fields: FieldRegistration[];
  activeFieldId: string | null;
  addField: (field: FieldRegistration) => void;
  removeField: (id: string) => void;
  setActiveField: (id: string | null) => void;
  updateField: (id: string, updates: Partial<FieldRegistration>) => void;
}

export const useFields = create<FieldsState>((set) => ({
  fields: [],
  activeFieldId: null,

  addField: (field) =>
    set((s) => ({ fields: [field, ...s.fields] })),

  removeField: (id) =>
    set((s) => ({
      fields: s.fields.filter((f) => f.id !== id),
      activeFieldId: s.activeFieldId === id ? null : s.activeFieldId,
    })),

  setActiveField: (id) => set({ activeFieldId: id }),

  updateField: (id, updates) =>
    set((s) => ({
      fields: s.fields.map((f) => (f.id === id ? { ...f, ...updates } : f)),
    })),
}));
