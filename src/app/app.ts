import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FirebaseError } from 'firebase/app';
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc
} from 'firebase/firestore';
import { db } from './firebase-client';

interface DuckEntry {
  duckNumber: number;
  enteredBy: string;
  enteredAtMs: number;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  readonly maxDuckNumber = 6000;

  activeCounterName = '';
  existingNames: string[] = [];
  selectedKnownName = '';
  newNameInput = '';

  duckNumberInput: number | null = null;
  searchNumberInput: number | null = null;

  addMessage = '';
  searchMessage = '';
  searchResult: DuckEntry | null = null;

  countedTotal = 0;
  recentEntries: DuckEntry[] = [];
  latestEntry: DuckEntry | null = null;

  isAdding = false;
  isSearching = false;

  private entriesByNumber = new Map<number, DuckEntry>();
  private unsubs: Array<() => void> = [];

  ngOnInit(): void {
    this.subscribeToKnownNames();
    this.subscribeToDuckEntries();
  }

  ngOnDestroy(): void {
    this.unsubs.forEach((unsubscribe) => unsubscribe());
  }

  get remainingTotal(): number {
    return Math.max(this.maxDuckNumber - this.countedTotal, 0);
  }

  get completionPercent(): number {
    return Math.min(100, Math.round((this.countedTotal / this.maxDuckNumber) * 1000) / 10);
  }

  async startCounting(): Promise<void> {
    const manualName = this.normalizeName(this.newNameInput);
    const selectedName = this.normalizeName(this.selectedKnownName);
    const chosenName = manualName || selectedName;

    if (!chosenName) {
      this.addMessage = 'Add your name or select one from the list to continue.';
      return;
    }

    if (manualName) {
      await this.upsertKnownName(manualName);
    }

    this.activeCounterName = chosenName;
    this.newNameInput = '';
    this.selectedKnownName = '';
    this.addMessage = '';
  }

  switchCounter(): void {
    this.activeCounterName = '';
    this.searchMessage = '';
    this.addMessage = '';
  }

  async addDuck(): Promise<void> {
    if (this.isAdding) return;
    this.isAdding = true;

    try {
      if (!this.activeCounterName) {
        this.addMessage = 'Select your name first.';
        return;
      }

      const duckNumber = Number(this.duckNumberInput);
      if (!Number.isInteger(duckNumber) || duckNumber < 1 || duckNumber > this.maxDuckNumber) {
        this.addMessage = `Duck number must be an integer between 1 and ${this.maxDuckNumber}.`;
        return;
      }

      const duckRef = doc(db, 'duckEntries', String(duckNumber));

      await runTransaction(db, async (transaction) => {
        const existingDoc = await transaction.get(duckRef);
        if (existingDoc.exists()) {
          throw new Error('DUPLICATE_ENTRY');
        }

        transaction.set(duckRef, {
          duckNumber,
          enteredBy: this.activeCounterName,
          enteredAtMs: Date.now()
        });
      });

      this.addMessage = `Duck ${duckNumber} added by ${this.activeCounterName}.`;
      this.duckNumberInput = null;
    } catch (error) {
      if (error instanceof Error && error.message === 'DUPLICATE_ENTRY') {
        const duckNumber = Number(this.duckNumberInput);
        const duplicate = await getDoc(doc(db, 'duckEntries', String(duckNumber)));
        if (duplicate.exists()) {
          const existingEntry = this.mapDuckEntry(duplicate.data(), duplicate.id);
          this.addMessage = `Duck ${duckNumber} already counted by ${existingEntry.enteredBy} at ${this.formatTime(existingEntry.enteredAtMs)}.`;
          return;
        }
      }

      if (error instanceof FirebaseError && error.code === 'permission-denied') {
        this.addMessage = 'Firebase rules blocked this write (permission-denied).';
        return;
      }

      this.addMessage = 'Could not add this duck number right now. Try again.';
    } finally {
      this.isAdding = false;
    }
  }

  async searchDuck(): Promise<void> {
    if (this.isSearching) return;
    this.isSearching = true;

    this.searchResult = null;
    this.searchMessage = '';

    try {
      const duckNumber = Number(this.searchNumberInput);
      if (!Number.isInteger(duckNumber) || duckNumber < 1 || duckNumber > this.maxDuckNumber) {
        this.searchMessage = `Search requires a duck number from 1 to ${this.maxDuckNumber}.`;
        return;
      }

      const localEntry = this.entriesByNumber.get(duckNumber);
      if (localEntry) {
        this.searchResult = localEntry;
        return;
      }

      const duckRef = doc(db, 'duckEntries', String(duckNumber));
      const duckSnapshot = await getDoc(duckRef);

      if (!duckSnapshot.exists()) {
        this.searchMessage = `Duck ${duckNumber} has not been counted yet.`;
        return;
      }

      this.searchResult = this.mapDuckEntry(duckSnapshot.data(), duckSnapshot.id);
    } catch (error) {
      if (error instanceof FirebaseError && error.code === 'permission-denied') {
        this.searchMessage = 'Firebase rules blocked this search (permission-denied).';
        return;
      }
      this.searchMessage = 'Could not search right now. Try again.';
    } finally {
      this.isSearching = false;
    }
  }

  formatTime(timeMs: number): string {
    return new Date(timeMs).toLocaleString();
  }

  trackByDuckNumber(_index: number, entry: DuckEntry): number {
    return entry.duckNumber;
  }

  private subscribeToKnownNames(): void {
    const namesQuery = query(collection(db, 'counterNames'), orderBy('normalized'));
    const unsubscribe = onSnapshot(namesQuery, (snapshot) => {
      this.existingNames = snapshot.docs
        .map((nameDoc) => (nameDoc.data()['displayName'] as string | undefined)?.trim() ?? '')
        .filter((name) => !!name);
    });

    this.unsubs.push(unsubscribe);
  }

  private subscribeToDuckEntries(): void {
    const entriesQuery = query(collection(db, 'duckEntries'), orderBy('enteredAtMs', 'desc'));
    const unsubscribe = onSnapshot(entriesQuery, (snapshot) => {
      const entries = snapshot.docs.map((duckDoc) => this.mapDuckEntry(duckDoc.data(), duckDoc.id));
      this.countedTotal = entries.length;
      this.latestEntry = entries[0] ?? null;
      this.recentEntries = entries.slice(0, 20);
      this.entriesByNumber = new Map(entries.map((entry) => [entry.duckNumber, entry]));
    });

    this.unsubs.push(unsubscribe);
  }

  private async upsertKnownName(displayName: string): Promise<void> {
    const cleanedName = this.normalizeName(displayName);
    const normalized = cleanedName.toLowerCase();
    const docId = normalized.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'counter';
    await setDoc(
      doc(db, 'counterNames', docId),
      {
        displayName: cleanedName,
        normalized,
        updatedAtMs: Date.now()
      },
      { merge: true }
    );
  }

  private normalizeName(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
  }

  private mapDuckEntry(raw: Record<string, unknown>, id: string): DuckEntry {
    const timestamp = raw['enteredAt'];
    const resolvedTime = timestamp instanceof Timestamp ? timestamp.toMillis() : Number(raw['enteredAtMs']) || Date.now();
    return {
      duckNumber: Number(raw['duckNumber'] ?? id),
      enteredBy: String(raw['enteredBy'] ?? 'Unknown'),
      enteredAtMs: resolvedTime
    };
  }
}
