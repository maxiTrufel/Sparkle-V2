const { QuestionProvider } = require('./questionProvider');

// Banco local de preguntas de programación/estructuras de datos — sin IA
// todavía (ver `questionProvider.js` para el contrato completo). Cada
// entrada guarda la opción correcta como TEXTO (`correct`), no como índice
// fijo: `generateQuestion()` reordena las opciones en cada llamada (ver
// `shuffle` más abajo), así que la respuesta correcta no cae siempre en el
// mismo lugar visual.
const QUESTION_BANK = [
  {
    prompt: '¿Cuál de las siguientes estructuras de datos sigue el principio FIFO (First In, First Out)?',
    options: ['Cola (Queue)', 'Pila (Stack)', 'Árbol binario', 'Tabla hash'],
    correct: 'Cola (Queue)',
  },
  {
    prompt: '¿Qué estructura de datos usa el principio LIFO (Last In, First Out)?',
    options: ['Pila (Stack)', 'Cola (Queue)', 'Lista enlazada', 'Grafo'],
    correct: 'Pila (Stack)',
  },
  {
    prompt: '¿Cuál es la complejidad temporal promedio de una búsqueda en una tabla hash?',
    options: ['O(1)', 'O(n)', 'O(log n)', 'O(n²)'],
    correct: 'O(1)',
  },
  {
    prompt: '¿Cuál es la complejidad temporal de Quicksort en el peor caso?',
    options: ['O(n²)', 'O(n log n)', 'O(n)', 'O(log n)'],
    correct: 'O(n²)',
  },
  {
    prompt: '¿Qué estructura de datos es más eficiente para implementar un recorrido en amplitud (BFS)?',
    options: ['Cola (Queue)', 'Pila (Stack)', 'Árbol binario de búsqueda', 'Tabla hash'],
    correct: 'Cola (Queue)',
  },
  {
    prompt: '¿Cuál de estos NO es un lenguaje de programación orientado a objetos?',
    options: ['SQL', 'Java', 'Python', 'C++'],
    correct: 'SQL',
  },
  {
    prompt: '¿Qué significa la sigla "API"?',
    options: [
      'Application Programming Interface',
      'Advanced Program Integration',
      'Automated Process Input',
      'Application Process Index',
    ],
    correct: 'Application Programming Interface',
  },
  {
    prompt: '¿Cuál es la complejidad temporal de acceder a un elemento de un array por índice?',
    options: ['O(1)', 'O(n)', 'O(log n)', 'O(n log n)'],
    correct: 'O(1)',
  },
  {
    prompt: '¿Qué tipo de árbol garantiza que se mantiene balanceado tras cada inserción?',
    options: ['Árbol AVL', 'Árbol binario simple', 'Lista enlazada', 'Montículo binario'],
    correct: 'Árbol AVL',
  },
  {
    prompt: '¿Cuál de estas NO es una operación típica de una pila (stack)?',
    options: ['Enqueue', 'Push', 'Pop', 'Peek'],
    correct: 'Enqueue',
  },
  {
    prompt: '¿Qué algoritmo de ordenamiento tiene complejidad O(n log n) en todos los casos?',
    options: ['Merge Sort', 'Bubble Sort', 'Insertion Sort', 'Selection Sort'],
    correct: 'Merge Sort',
  },
  {
    prompt: '¿Cuál es el propósito principal de una tabla hash?',
    options: [
      'Acceso rápido a datos mediante una clave',
      'Ordenar elementos automáticamente',
      'Recorrer un grafo',
      'Comprimir archivos',
    ],
    correct: 'Acceso rápido a datos mediante una clave',
  },
];

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class RandomQuestionProvider extends QuestionProvider {
  async generateQuestion() {
    const picked = QUESTION_BANK[Math.floor(Math.random() * QUESTION_BANK.length)];
    const options = shuffle(picked.options);
    return { prompt: picked.prompt, options, correctOptionIndex: options.indexOf(picked.correct) };
  }
}

module.exports = { RandomQuestionProvider };
