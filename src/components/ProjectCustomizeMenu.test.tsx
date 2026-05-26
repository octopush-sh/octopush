import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectCustomizeMenu } from './ProjectCustomizeMenu';
import type { TintName } from '@/lib/types';

describe('ProjectCustomizeMenu', () => {
  const mockOnCustomized = vi.fn();
  const mockOnCancel = vi.fn();

  const defaultProps = {
    currentName: 'My Project',
    currentTint: 'brass' as TintName,
    onCustomized: mockOnCustomized,
    onCancel: mockOnCancel,
  };

  beforeEach(() => {
    mockOnCustomized.mockClear();
    mockOnCancel.mockClear();
  });

  it('renders with current values', () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const nameInput = screen.getByDisplayValue('My Project') as HTMLInputElement;
    expect(nameInput).toBeInTheDocument();
    expect(nameInput.value).toBe('My Project');
  });

  it('updates name when input changes', async () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const nameInput = screen.getByDisplayValue('My Project') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Updated Project' } });

    await waitFor(() => {
      expect(nameInput.value).toBe('Updated Project');
    });
  });

  it('allows tint selection', () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const tintButtons = screen.getAllByRole('button', { pressed: false });
    // Tint buttons have aria-pressed attribute
    const firstTintButton = tintButtons[0];

    fireEvent.click(firstTintButton);

    // Button should now be marked as pressed
    expect(firstTintButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onCustomized with correct args when save button clicked', async () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const nameInput = screen.getByDisplayValue('My Project') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'New Name' } });

    const saveButton = screen.getByText('Save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnCustomized).toHaveBeenCalledWith('New Name', 'brass');
    });
  });

  it('does not call onCustomized when cancel button clicked', () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const cancelButton = screen.getByText('Cancel');
    fireEvent.click(cancelButton);

    expect(mockOnCustomized).not.toHaveBeenCalled();
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('disables save button when name is empty', async () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const nameInput = screen.getByDisplayValue('My Project') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '' } });

    await waitFor(() => {
      const saveButton = screen.getByText('Save') as HTMLButtonElement;
      expect(saveButton).toBeDisabled();
    });
  });

  it('disables save button when only whitespace is entered', async () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const nameInput = screen.getByDisplayValue('My Project') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '   ' } });

    await waitFor(() => {
      const saveButton = screen.getByText('Save') as HTMLButtonElement;
      expect(saveButton).toBeDisabled();
    });
  });

  it('trims whitespace before submitting', async () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const nameInput = screen.getByDisplayValue('My Project') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '  Trimmed Name  ' } });

    const saveButton = screen.getByText('Save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnCustomized).toHaveBeenCalledWith('Trimmed Name', 'brass');
    });
  });

  it('can change tint selection', async () => {
    render(<ProjectCustomizeMenu {...defaultProps} />);

    const tintButtons = screen.getAllByRole('button', { pressed: false });
    // Skip Save/Cancel buttons (last 2) and get the last tint button
    const lastTintButton = tintButtons[tintButtons.length - 1];

    fireEvent.click(lastTintButton);

    await waitFor(() => {
      expect(lastTintButton).toHaveAttribute('aria-pressed', 'true');
    });

    // Click save with new tint
    const saveButton = screen.getByText('Save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnCustomized).toHaveBeenCalled();
      // The tint should be one of the available ones (bone, smoke, etc.)
      const call = mockOnCustomized.mock.calls[0];
      expect(call[0]).toBe('My Project');
      expect(typeof call[1]).toBe('string');
    });
  });
});
