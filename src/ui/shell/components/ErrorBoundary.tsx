/**
 * Garde-fou d'affichage : si un écran (ou l'éditeur de plan) lève une erreur, on le dit gentiment et on propose
 * de réessayer ou d'annuler la dernière action — le projet, lui, est toujours en mémoire et enregistré.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  title: string;
  text: string;
  retryLabel: string;
  undoLabel?: string;
  onUndo?(): void;
  /** Change quand le contenu change (écran, étage) : l'erreur affichée est alors oubliée. */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  resetKey: string | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Trace locale pour le support ; rien n'est envoyé nulle part.
    console.error('[Plan2CPE]', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="notice notice--warn crash" role="alert">
        <div className="notice__body">
          <strong>{this.props.title}</strong>
          <span>{this.props.text}</span>
          <code className="crash__detail">{error.message}</code>
        </div>
        <div className="notice__actions">
          <button type="button" className="btn btn--primary" onClick={() => this.setState({ error: null })}>
            {this.props.retryLabel}
          </button>
          {this.props.onUndo && this.props.undoLabel ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                this.props.onUndo?.();
                this.setState({ error: null });
              }}
            >
              {this.props.undoLabel}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}
