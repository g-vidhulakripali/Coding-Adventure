import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { detectCategory } from '../../core/repository/fileTypes';
import type { RepositoryFile } from '../../core/repository/types';
import { FileExplorer } from './FileExplorer';

const files: RepositoryFile[] = ['main.py', 'pkg/util.py', 'pkg/deep/data.csv', 'blob.bin'].map((path) => ({
  path,
  name: path.split('/').pop()!,
  size: 10,
  category: detectCategory(path),
}));

describe('FileExplorer', () => {
  it('shows the total file count and flags unsupported files', () => {
    render(<FileExplorer files={files} selectedPath={null} onSelect={() => {}} />);
    expect(screen.getByText('4 files')).toBeTruthy();
    expect(screen.getByText('unsupported')).toBeTruthy();
  });

  it('reveals the folders of the selected file and reports selection', () => {
    const onSelect = vi.fn();
    render(<FileExplorer files={files} selectedPath="pkg/deep/data.csv" onSelect={onSelect} />);
    const selected = screen.getByRole('button', { name: /data\.csv/ });
    expect(selected.getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: /util\.py/ }));
    expect(onSelect).toHaveBeenCalledWith('pkg/util.py');
  });

  it('filters by path', () => {
    render(<FileExplorer files={files} selectedPath={null} onSelect={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'csv' } });
    expect(screen.getByText('1 of 4 files match')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /main\.py/ })).toBeNull();
  });
});
