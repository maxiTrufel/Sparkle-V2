import { useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, GraduationCapIcon } from './icons';
import { getStoredTogglePosition, setStoredTogglePosition } from '../utils/togglePosition';

const TAB_HEIGHT = 56;
const EDGE_MARGIN = 12;
const DRAG_THRESHOLD_PX = 4;

function clampTop(top) {
  const min = TAB_HEIGHT / 2 + EDGE_MARGIN;
  const max = window.innerHeight - TAB_HEIGHT / 2 - EDGE_MARGIN;
  return Math.min(Math.max(top, min), max);
}

export default function ToggleTab({ isOpen, onToggle }) {
  const [topPx, setTopPx] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOrigin = useRef(null); // { startY, startTop }
  const didDragRef = useRef(false);

  // Sin posición guardada, arranca centrada verticalmente (Etapa 12).
  useEffect(() => {
    let cancelled = false;
    getStoredTogglePosition().then((stored) => {
      if (cancelled) return;
      setTopPx(stored ?? window.innerHeight / 2);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleMouseMove = (event) => {
    if (!dragOrigin.current) return;
    const delta = event.clientY - dragOrigin.current.startY;
    if (Math.abs(delta) > DRAG_THRESHOLD_PX) {
      didDragRef.current = true;
    }
    setTopPx(clampTop(dragOrigin.current.startTop + delta));
  };

  const handleMouseUp = () => {
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
    setIsDragging(false);
    dragOrigin.current = null;

    if (didDragRef.current) {
      setTopPx((current) => {
        const finalTop = clampTop(current ?? window.innerHeight / 2);
        setStoredTogglePosition(finalTop);
        return finalTop;
      });
    }
  };

  const handleMouseDown = (event) => {
    event.preventDefault(); // evita selección de texto de la página al arrastrar
    dragOrigin.current = { startY: event.clientY, startTop: topPx ?? window.innerHeight / 2 };
    setIsDragging(true);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleClick = () => {
    // Un drag real no debe además togglear el panel al soltar el mouse.
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    onToggle();
  };

  return (
    <button
      type="button"
      className={`sparkle-toggle-tab${isOpen ? ' sparkle-toggle-tab--open' : ''}${
        isDragging ? ' sparkle-toggle-tab--dragging' : ''
      }`}
      style={{ top: topPx !== null ? `${topPx}px` : '50%' }}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      aria-label={isOpen ? 'Cerrar panel de Sparkle' : 'Abrir panel de Sparkle'}
      aria-expanded={isOpen}
    >
      {/* Siempre montada (nunca condicional): el clip-path del botón es lo
          que la oculta en reposo, para poder animar el reveal en hover
          sin togglear el DOM ni animar `width` (ver panel.css, Etapa 23). */}
      <span className="sparkle-toggle-brand">
        <GraduationCapIcon size={14} />
        <span className="sparkle-toggle-label">Sparkle</span>
      </span>
      <span className="sparkle-toggle-icon">
        {isOpen ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}
      </span>
    </button>
  );
}
