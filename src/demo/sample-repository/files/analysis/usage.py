"""Usage analysis helpers for the Code Playground sample project."""

import pandas as pd


def usage_for_first_station(hours_usage: pd.Series, stationary: pd.Series) -> float:
    """Return the usage hours recorded for the first stationary position."""
    result = float(
        hours_usage.to_numpy(dtype=float)[stationary.iloc[0]]
    )
    return result


class UsageReport:
    """Collects usage figures loaded from a CSV file."""

    def __init__(self, csv_path="data/usage.csv"):
        self.csv_path = csv_path
        self.frame = None

    def load(self):
        self.frame = pd.read_csv(self.csv_path)
        return self.frame

    @property
    def total_hours(self):
        if self.frame is None:
            return 0.0
        return float(self.frame["hours"].sum())

    async def refresh(self):
        return self.load()


if __name__ == "__main__":
    hours_usage = pd.Series([10.5, 20.0, 30.5])
    stationary = pd.Series([2, 0, 1])
    print(usage_for_first_station(hours_usage, stationary))
