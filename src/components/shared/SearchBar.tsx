import { useState } from 'react';
import { Search, X } from 'lucide-react';

interface SearchBarProps {
  onSearch: (query: string) => void;
  placeholder?: string;
}

export function SearchBar({ onSearch, placeholder = '搜索...' }: SearchBarProps) {
  const [query, setQuery] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    onSearch(val);
  };

  const handleClear = () => {
    setQuery('');
    onSearch('');
  };

  return (
    <div className="search-bar">
      <Search size={16} />
      <input
        type="text"
        value={query}
        onChange={handleChange}
        placeholder={placeholder}
      />
      {query && (
        <button onClick={handleClear} className="clear-btn">
          <X size={16} />
        </button>
      )}
    </div>
  );
}
